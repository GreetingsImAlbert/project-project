import type { APIRoute } from 'astro';
import { errorResponse } from '../../../../lib/error-report';
import { forumBodyProblem, normalizeForumBody, readForumJson } from '../../../../lib/forum';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
	if (!locals.user) return new Response('Unauthorized', { status: 401 });

	const payload = await readForumJson(request);
	if ('error' in payload) return new Response(payload.error, { status: 400 });

	const problem = forumBodyProblem(payload.value.body);
	if (problem) return new Response(problem, { status: 400 });

	const { data, error } = await locals.supabase
		.from('forum_posts')
		.insert({ author_id: locals.user.id, body: normalizeForumBody(payload.value.body as string) })
		.select('id, created_at')
		.single();

	if (error || !data) return errorResponse({ request, userId: locals.user.id, privateMessage: error?.message ?? 'unknown error', action: 'Failed to create post.' });
	return Response.json({ id: data.id, createdAt: data.created_at }, { status: 201 });
};
