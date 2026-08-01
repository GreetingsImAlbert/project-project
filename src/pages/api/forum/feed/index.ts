import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getSupabaseAdmin } from '../../../../lib/supabase/admin';
import { readForumFeed } from '../../../../lib/forum';

export const prerender = false;

export const GET: APIRoute = async ({ locals, url }) => {
	if (!locals.user) return new Response('Unauthorized', { status: 401 });

	const result = await readForumFeed(getSupabaseAdmin(env), locals.user.id, url.searchParams.get('before'));
	if ('error' in result) return new Response(result.error, { status: 400 });
	return Response.json(result);
};
