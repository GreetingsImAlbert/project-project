import type { APIRoute } from 'astro';
import { forumBodyProblem, normalizeForumBody, readForumJson } from '../../../../../../lib/forum';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) return new Response('Unauthorized', { status: 401 });
	const postId = params.postId;
	if (!postId) return new Response('Post not found', { status: 404 });

	const payload = await readForumJson(request);
	if ('error' in payload) return new Response(payload.error, { status: 400 });

	const problem = forumBodyProblem(payload.value.body);
	if (problem) return new Response(problem, { status: 400 });

	const { data: post, error: postError } = await locals.supabase
		.from('forum_posts')
		.select('id, deleted_at')
		.eq('id', postId)
		.maybeSingle();
	if (postError) return new Response(`Failed to read post: ${postError.message}`, { status: 500 });
	if (!post) return new Response('Post not found', { status: 404 });
	if (post.deleted_at) return new Response('Replies are disabled for deleted posts', { status: 409 });

	const { data, error } = await locals.supabase
		.from('forum_replies')
		.insert({ post_id: postId, author_id: locals.user.id, body: normalizeForumBody(payload.value.body as string) })
		.select('id, created_at')
		.single();

	if (error || !data) return new Response(`Failed to create reply: ${error?.message ?? 'unknown error'}`, { status: 500 });
	return Response.json({ id: data.id, createdAt: data.created_at }, { status: 201 });
};
