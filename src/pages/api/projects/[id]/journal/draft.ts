import type { APIRoute } from 'astro';
import { errorResponse } from '../../../../../lib/error-report';
import { MAX_DRAFT_CHARS } from '../../../../../lib/journal';

export const prerender = false;

// Autosave for the always-open textarea. Every keystroke that reaches here (see
// JournalPage.svelte's debounce) both persists the draft and — via the
// journal_drafts row being in the `supabase_realtime` publication — is what every
// other open tab actually syncs against; there's no separate broadcast path.
export const PUT: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const projectId = params.id;

	const { data: membership } = await locals.supabase
		.from('project_members')
		.select('role')
		.eq('project_id', projectId)
		.eq('user_id', locals.user.id)
		.single();

	if (!membership || !['owner', 'editor'].includes(membership.role)) {
		return new Response('Forbidden', { status: 403 });
	}

	const body = (await request.json()) as { content?: unknown };
	if (typeof body.content !== 'string') {
		return new Response('Missing content', { status: 400 });
	}
	if (body.content.length > MAX_DRAFT_CHARS) {
		return new Response(`Max ${MAX_DRAFT_CHARS.toLocaleString()} characters per day`, { status: 400 });
	}

	// Upserted rather than assumed-existing: the row is normally created by the page's
	// own SSR load (ensureJournalDraft) before this can ever fire, but a save shouldn't
	// hard-fail on the (recoverable) chance that row is somehow missing.
	const { data: updated, error } = await locals.supabase
		.from('journal_drafts')
		.upsert(
			{
				project_id: projectId,
				content: body.content,
				updated_by: locals.user.id,
				updated_at: new Date().toISOString(),
			},
			{ onConflict: 'project_id' },
		)
		.select('draft_date, updated_at')
		.single();

	if (error) {
		return errorResponse({ request, userId: locals.user.id, privateMessage: error.message, action: 'Failed to save draft.', context: { projectId: projectId ?? null } });
	}

	return Response.json(updated);
};
