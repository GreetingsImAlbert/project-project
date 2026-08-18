import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { errorResponse } from '../../../../../../lib/error-report';
import {
	canEditJournal,
	journalSchemaClient,
	MAX_DRAFT_CHARS,
	type JournalKind,
	type JournalVisibility,
} from '../../../../../../lib/journal';
import { getSupabaseAdmin } from '../../../../../../lib/supabase/admin';

export const prerender = false;

export const PUT: APIRoute = async ({ params, request, locals }) => {
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
		return errorResponse({ request, userId: locals.user.id, privateMessage: membershipError.message, action: 'Failed to save draft.', context: { projectId, journalFileId } });
	}
	// A non-member cannot use the project-scoped route to probe journal IDs.
	if (!membership) return new Response('Journal not found', { status: 404 });

	const db = journalSchemaClient(getSupabaseAdmin(env));
	const { data: journal, error: journalError } = await db
		.from('files')
		.select('uploaded_by, journal_kind, journal_visibility')
		.eq('id', journalFileId)
		.eq('project_id', projectId)
		.eq('is_journal', true)
		.is('deleted_at', null)
		.maybeSingle();
	if (journalError) {
		return errorResponse({ request, userId: locals.user.id, privateMessage: journalError.message, action: 'Failed to save draft.', context: { projectId, journalFileId } });
	}
	if (!journal) return new Response('Journal not found', { status: 404 });

	if (!canEditJournal({
		kind: journal.journal_kind as JournalKind,
		creatorId: journal.uploaded_by,
		visibility: journal.journal_visibility as JournalVisibility | null,
	}, { viewerId: locals.user.id, isProjectMember: true, role: membership.role })) {
		return new Response('Forbidden', { status: 403 });
	}

	let body: { content?: unknown };
	try {
		body = await request.json() as { content?: unknown };
	} catch {
		return new Response('Invalid request body', { status: 400 });
	}
	if (typeof body.content !== 'string') return new Response('Missing content', { status: 400 });
	if (body.content.length > MAX_DRAFT_CHARS) {
		return new Response(`Max ${MAX_DRAFT_CHARS.toLocaleString()} characters per day`, { status: 400 });
	}

	const { data: updated, error } = await journalSchemaClient(locals.supabase)
		.from('journal_drafts')
		.upsert({
			project_id: projectId,
			journal_file_id: journalFileId,
			content: body.content,
			updated_by: locals.user.id,
			updated_at: new Date().toISOString(),
		}, { onConflict: 'journal_file_id' })
		.select('journal_file_id, draft_date, updated_at')
		.single();
	if (error) {
		return errorResponse({ request, userId: locals.user.id, privateMessage: error.message, action: 'Failed to save draft.', context: { projectId, journalFileId } });
	}

	return Response.json(updated);
};
