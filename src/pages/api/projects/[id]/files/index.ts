import type { APIRoute } from 'astro';
import { errorResponse } from '../../../../../lib/error-report';
import {
	canDeleteJournal,
	canEditJournal,
	canReadJournal,
	journalSchemaClient,
	type JournalKind,
	type JournalVisibility,
} from '../../../../../lib/journal';

export const prerender = false;

export const GET: APIRoute = async ({ params, url, request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const projectId = params.id;
	const folderId = url.searchParams.get('folderId');
	const { data: membership } = await locals.supabase
		.from('project_members')
		.select('role')
		.eq('project_id', projectId)
		.eq('user_id', locals.user.id)
		.maybeSingle();
	if (!membership) return new Response('Project not found', { status: 404 });

	let query = journalSchemaClient(locals.supabase)
		.from('files')
		.select('id, filename, size_bytes, mime_type, created_at, uploaded_by, is_journal, journal_kind, journal_visibility, is_public, profiles(display_name)')
		.eq('project_id', projectId)
		.is('deleted_at', null)
		.order('created_at', { ascending: false });

	query = folderId ? query.eq('folder_id', folderId) : query.is('folder_id', null);

	const { data: files, error } = await query;

	if (error) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to load files: ${error.message}`,
			action: 'Failed to load files.',
			context: { projectId: projectId ?? null },
		});
	}

	const subject = { viewerId: locals.user.id, isProjectMember: true, role: membership.role };
	const roleCanEditFiles = membership.role === 'owner' || membership.role === 'editor';
	const visibleFiles = (files ?? []).flatMap((file: any) => {
		if (!file.is_journal) return [{ ...file, canEdit: roleCanEditFiles, canDelete: roleCanEditFiles }];
		if (!file.journal_kind) return [];
		const target = {
			kind: file.journal_kind as JournalKind,
			creatorId: file.uploaded_by,
			visibility: file.journal_visibility as JournalVisibility | null,
		};
		if (!canReadJournal(target, subject)) return [];
		return [{ ...file, canEdit: canEditJournal(target, subject), canDelete: canDeleteJournal(target, subject) }];
	});

	return Response.json(visibleFiles);
};
