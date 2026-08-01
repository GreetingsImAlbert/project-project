import type { APIRoute } from 'astro';
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
		.select('id')
		.single();

	if (error || !data) return new Response(`Failed to create post: ${error?.message ?? 'unknown error'}`, { status: 500 });
	return Response.json({ id: data.id }, { status: 201 });
};
