import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { errorResponse } from '../../../../../../lib/error-report';
import {
	canDeleteJournal,
	journalSchemaClient,
	type JournalKind,
} from '../../../../../../lib/journal';
import { getSupabaseAdmin } from '../../../../../../lib/supabase/admin';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) return new Response('Unauthorized', { status: 401 });
	const projectId = params.id;
	const journalFileId = params.journalFileId;
	if (!projectId || !journalFileId) return new Response('Journal not found', { status: 404 });

	const { data: membership, error: membershipError } = await locals.supabase
		.from('project_members')
		.select('role')
		.eq('project_id', projectId)
		.eq('user_id', locals.user.id)
		.maybeSingle();
	if (membershipError) {
		return errorResponse({ request, userId: locals.user.id, privateMessage: membershipError.message, action: 'Failed to delete journal.', context: { projectId, journalFileId } });
	}
	if (!membership) return new Response('Journal not found', { status: 404 });

	const db = journalSchemaClient(getSupabaseAdmin(env));
	// Deliberately excludes filename, R2 key, draft, and content: an owner needs
	// only enough private-journal metadata to authorize deletion.
	const { data: journal, error: journalError } = await db
		.from('files')
		.select('uploaded_by, journal_kind, deleted_at')
		.eq('id', journalFileId)
		.eq('project_id', projectId)
		.eq('is_journal', true)
		.maybeSingle();
	if (journalError) {
		return errorResponse({ request, userId: locals.user.id, privateMessage: journalError.message, action: 'Failed to delete journal.', context: { projectId, journalFileId } });
	}
	if (!journal) return new Response('Journal not found', { status: 404 });

	if (!canDeleteJournal({
		kind: journal.journal_kind as JournalKind,
		creatorId: journal.uploaded_by,
		visibility: null,
	}, { viewerId: locals.user.id, isProjectMember: true, role: membership.role })) {
		return new Response('Forbidden', { status: 403 });
	}

	let deletedAt = journal.deleted_at as string | null;
	if (!journal.deleted_at) {
		deletedAt = new Date().toISOString();
		const { error: fileDeleteError } = await db
			.from('files')
			.update({ deleted_at: deletedAt })
			.eq('id', journalFileId)
			.eq('project_id', projectId)
			.eq('journal_kind', 'personal')
			.is('deleted_at', null);
		if (fileDeleteError) {
			return errorResponse({ request, userId: locals.user.id, privateMessage: fileDeleteError.message, action: 'Failed to delete journal.', context: { projectId, journalFileId } });
		}
	}

	// Delete by key without selecting the draft: project owners may delete a
	// Private journal but must never receive or load its content.
	const { error: draftDeleteError } = await db.from('journal_drafts').delete().eq('journal_file_id', journalFileId);
	if (draftDeleteError) {
		if (!journal.deleted_at) {
			await db.from('files').update({ deleted_at: null }).eq('id', journalFileId).eq('deleted_at', deletedAt);
		}
		return errorResponse({ request, userId: locals.user.id, privateMessage: draftDeleteError.message, action: 'Failed to delete journal.', context: { projectId, journalFileId } });
	}

	return new Response(null, { status: 204 });
};
