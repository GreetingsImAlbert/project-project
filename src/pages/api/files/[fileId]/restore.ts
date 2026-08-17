import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { errorResponse } from '../../../../lib/error-report';
import { getSupabaseAdmin } from '../../../../lib/supabase/admin';
import {
	canDeleteJournal,
	ensureJournalDraft,
	ensureJournalsFolder,
	journalSchemaClient,
	type JournalKind,
	type JournalVisibility,
} from '../../../../lib/journal';

export const prerender = false;

// Undoes delete.ts. If the file's folder is itself still trashed, it's reparented
// to the project root instead — restoring one item deep inside a trashed tree
// shouldn't leave it invisible under a still-deleted folder.
export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const fileId = params.fileId;
	const admin = getSupabaseAdmin(env);

	const { data: file, error: fileError } = await journalSchemaClient(admin)
		.from('files')
		.select('project_id, folder_id, uploaded_by, uploader_deleted_at, is_journal, journal_kind, journal_visibility, deleted_at')
		.eq('id', fileId)
		.single();

	if (fileError || !file) {
		return new Response('File not found', { status: 404 });
	}

	if (!file.deleted_at) {
		return new Response('File is not in the trash', { status: 400 });
	}

	const { data: membership } = await locals.supabase
		.from('project_members')
		.select('role')
		.eq('project_id', file.project_id)
		.eq('user_id', locals.user.id)
		.maybeSingle();

	if (!membership) return new Response('File not found', { status: 404 });
	if (file.is_journal && file.journal_kind === 'personal' && file.uploader_deleted_at) {
		return new Response('This journal is frozen for orphan cleanup', { status: 410 });
	}
	const mayRestore = file.is_journal
		? canDeleteJournal({
			kind: file.journal_kind as JournalKind,
			creatorId: file.uploaded_by,
			visibility: file.journal_visibility as JournalVisibility | null,
		}, { viewerId: locals.user.id, isProjectMember: true, role: membership.role })
		: ['owner', 'editor'].includes(membership.role);
	if (!mayRestore) {
		return new Response('Forbidden', { status: 403 });
	}

	let folderId: string | null;
	if (file.is_journal) {
		if (file.journal_kind !== 'personal') return new Response('The group journal cannot be restored from Trash', { status: 403 });
		const { data: activeJournal } = await journalSchemaClient(admin)
			.from('files')
			.select('id')
			.eq('project_id', file.project_id)
			.eq('uploaded_by', file.uploaded_by)
			.eq('journal_kind', 'personal')
			.is('deleted_at', null)
			.neq('id', fileId)
			.maybeSingle();
		if (activeJournal) return new Response('An active personal journal already exists for this member', { status: 409 });
		folderId = (await ensureJournalsFolder(admin, file.project_id)).id;
	} else {
		folderId = file.folder_id;
		if (folderId) {
			const { data: folder } = await journalSchemaClient(admin).from('folders').select('deleted_at, is_journals_folder').eq('id', folderId).maybeSingle();
			if (!folder || folder.deleted_at || folder.is_journals_folder) folderId = null;
		}
	}

	const { error } = await journalSchemaClient(admin)
		.from('files')
		.update({ deleted_at: null, folder_id: folderId })
		.eq('id', fileId);

	if (error) {
		if (error.code === '23505') return new Response('An active journal of this kind already exists', { status: 409 });
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to restore file: ${error.message}`,
			action: 'Failed to restore file.',
			context: { fileId: fileId ?? null, projectId: file.project_id },
		});
	}

	if (file.is_journal) {
		try {
			await ensureJournalDraft(admin, file.project_id, fileId!);
		} catch (draftError) {
			await journalSchemaClient(admin).from('files').update({ deleted_at: file.deleted_at }).eq('id', fileId);
			return errorResponse({
				request,
				userId: locals.user.id,
				privateMessage: `Failed to recreate restored journal draft: ${draftError instanceof Error ? draftError.message : String(draftError)}`,
				action: 'Failed to restore journal.',
				context: { fileId: fileId ?? null, projectId: file.project_id },
			});
		}
	}

	return new Response(null, { status: 204 });
};
