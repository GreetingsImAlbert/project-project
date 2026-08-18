import type { APIRoute } from 'astro';

export const prerender = false;

// JournalPage.svelte's browser Supabase client (lib/supabase/browser.ts) has no
// session of its own — it hands this access token to realtime.setAuth() so the
// journal_drafts Postgres Changes subscription is evaluated under this member's
// own RLS, not as an anonymous connection (which the table's select policy would
// simply return nothing for). Re-fetched and re-applied periodically by the
// component rather than handed a refresh token, since access tokens expire in
// about an hour and only the server ever holds the means to mint a new one.
export const GET: APIRoute = async ({ params, locals }) => {
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

	// Read-only members also subscribe to journals they may view. Per-journal RLS
	// decides which draft rows the token can actually receive.
	if (!membership) {
		return new Response('Forbidden', { status: 403 });
	}

	const {
		data: { session },
	} = await locals.supabase.auth.getSession();

	if (!session) {
		return new Response('No session', { status: 401 });
	}

	return Response.json({ accessToken: session.access_token, expiresAt: session.expires_at ?? null });
};
