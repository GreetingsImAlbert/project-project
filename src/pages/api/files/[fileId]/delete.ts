import type { APIRoute } from 'astro';
import { errorResponse } from '../../../../lib/error-report';
import { canDeleteJournal, journalSchemaClient, type JournalKind, type JournalVisibility } from '../../../../lib/journal';

export const prerender = false;

// Soft-delete — moves the file to the project's Trash instead of removing it.
// The R2 object is left alone until the trash cron actually purges the row (see
// src/lib/trash.ts) — restore.ts undoes this, purge.ts does the same removal on demand.
export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const fileId = params.fileId;

	const { data: file, error: fileError } = await journalSchemaClient(locals.supabase)
		.from('files')
		.select('project_id, uploaded_by, is_journal, journal_kind, journal_visibility')
		.eq('id', fileId)
		.single();

	if (fileError || !file) {
		return new Response('File not found', { status: 404 });
	}

	const { data: membership } = await locals.supabase
		.from('project_members')
		.select('role')
		.eq('project_id', file.project_id)
		.eq('user_id', locals.user.id)
		.single();

	const mayDelete = !!membership && (file.is_journal
		? canDeleteJournal({
			kind: file.journal_kind as JournalKind,
			creatorId: file.uploaded_by,
			visibility: file.journal_visibility as JournalVisibility | null,
		}, { viewerId: locals.user.id, isProjectMember: true, role: membership.role })
		: ['owner', 'editor'].includes(membership.role));
	if (!mayDelete) {
		return new Response('Forbidden', { status: 403 });
	}

	const deletedAt = new Date().toISOString();
	const { error } = await locals.supabase.from('files').update({ deleted_at: deletedAt }).eq('id', fileId);

	if (error) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to delete file: ${error.message}`,
			action: 'Failed to delete file.',
			context: { fileId: fileId ?? null, projectId: file.project_id },
		});
	}

	if (file.is_journal) {
		const { error: draftError } = await journalSchemaClient(locals.supabase)
			.from('journal_drafts')
			.delete()
			.eq('journal_file_id', fileId);
		if (draftError) {
			await locals.supabase.from('files').update({ deleted_at: null }).eq('id', fileId).eq('deleted_at', deletedAt);
			return new Response('Failed to remove the journal draft', { status: 500 });
		}
	}

	return new Response(null, { status: 204 });
};
