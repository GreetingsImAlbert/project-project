import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { errorResponse } from '../../../../../../lib/error-report';
import {
	canChangeJournalVisibility,
	journalSchemaClient,
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
		return errorResponse({ request, userId: locals.user.id, privateMessage: membershipError.message, action: 'Failed to update journal visibility.', context: { projectId, journalFileId } });
	}
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
		return errorResponse({ request, userId: locals.user.id, privateMessage: journalError.message, action: 'Failed to update journal visibility.', context: { projectId, journalFileId } });
	}
	if (!journal) return new Response('Journal not found', { status: 404 });

	const target = {
		kind: journal.journal_kind as JournalKind,
		creatorId: journal.uploaded_by,
		visibility: journal.journal_visibility as JournalVisibility | null,
	};
	if (!canChangeJournalVisibility(target, { viewerId: locals.user.id, isProjectMember: true, role: membership.role })) {
		return new Response('Forbidden', { status: 403 });
	}

	let visibility: unknown;
	try {
		visibility = (await request.json() as { visibility?: unknown }).visibility;
	} catch {
		return new Response('Invalid request body', { status: 400 });
	}
	if (visibility !== 'private' && visibility !== 'members' && visibility !== 'public') {
		return new Response('Invalid visibility value', { status: 400 });
	}

	const { data: updated, error } = await journalSchemaClient(locals.supabase)
		.from('files')
		.update({ journal_visibility: visibility })
		.eq('id', journalFileId)
		.eq('project_id', projectId)
		.eq('journal_kind', 'personal')
		.eq('uploaded_by', locals.user.id)
		.is('deleted_at', null)
		.select('journal_visibility')
		.maybeSingle();
	if (error) {
		return errorResponse({ request, userId: locals.user.id, privateMessage: error.message, action: 'Failed to update journal visibility.', context: { projectId, journalFileId } });
	}
	if (!updated) return new Response('Forbidden', { status: 403 });

	return Response.json({ visibility: updated.journal_visibility });
};
