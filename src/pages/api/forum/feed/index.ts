import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { errorResponse } from '../../../../lib/error-report';
import { getSupabaseAdmin } from '../../../../lib/supabase/admin';
import { readForumFeed } from '../../../../lib/forum';

export const prerender = false;

export const GET: APIRoute = async ({ locals, request, url }) => {
	// The Workshop is public by design. Reads go through the
	// service-role client, so a guest sees the same feed a member does; `userId`
	// only personalizes `likedByMe`, which a guest never has set. The admin
	// client reads past RLS, which is fine here: forum content is intentionally
	// public and this endpoint is the only read path into it.
	const result = await readForumFeed(getSupabaseAdmin(env), locals.user?.id ?? null, url.searchParams.get('before'));
	if ('error' in result) {
		if (result.error === 'Invalid pagination cursor') return new Response(result.error, { status: 400 });
		return errorResponse({ request, userId: locals.user?.id ?? null, privateMessage: result.error, action: 'Failed to load forum feed.' });
	}
	return Response.json(result);
};
