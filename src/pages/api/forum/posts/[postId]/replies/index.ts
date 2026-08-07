import type { APIRoute } from 'astro';
import { errorResponse } from '../../../../../../lib/error-report';
import { forumBodyProblem, forumParentReplyProblem, normalizeForumBody, readForumJson } from '../../../../../../lib/forum';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) return new Response('Unauthorized', { status: 401 });
	const postId = params.postId;
	if (!postId) return new Response('Post not found', { status: 404 });

	const payload = await readForumJson(request);
	if ('error' in payload) return new Response(payload.error, { status: 400 });

	const problem = forumBodyProblem(payload.value.body);
	if (problem) return new Response(problem, { status: 400 });
	const parentReplyProblem = forumParentReplyProblem(payload.value.parentReplyId);
	if (parentReplyProblem) return new Response(parentReplyProblem, { status: 400 });
	const parentReplyId = typeof payload.value.parentReplyId === 'string' ? payload.value.parentReplyId : null;

	const { data: post, error: postError } = await locals.supabase
		.from('forum_posts')
		.select('id, deleted_at')
		.eq('id', postId)
		.maybeSingle();
	if (postError) return errorResponse({ request, userId: locals.user.id, privateMessage: postError.message, action: 'Failed to read post.', context: { postId } });
	if (!post) return new Response('Post not found', { status: 404 });
	if (post.deleted_at) return new Response('Replies are disabled for deleted posts', { status: 409 });

	if (parentReplyId) {
		const { data: parentReply, error: parentReplyError } = await locals.supabase
			.from('forum_replies')
			.select('id, post_id, deleted_at')
			.eq('id', parentReplyId)
			.maybeSingle();
		if (parentReplyError) return errorResponse({ request, userId: locals.user.id, privateMessage: parentReplyError.message, action: 'Failed to read parent reply.', context: { postId, parentReplyId } });
		if (!parentReply) return new Response('Parent reply not found', { status: 404 });
		if (parentReply.post_id !== postId) return new Response('Parent reply belongs to another post', { status: 400 });
		if (parentReply.deleted_at) return new Response('Replies to deleted replies are disabled', { status: 409 });
	}

	const { data, error } = await locals.supabase
		.from('forum_replies')
		.insert({ post_id: postId, parent_reply_id: parentReplyId, author_id: locals.user.id, body: normalizeForumBody(payload.value.body as string) })
		.select('id, parent_reply_id, created_at')
		.single();

	if (error || !data) return errorResponse({ request, userId: locals.user.id, privateMessage: error?.message ?? 'unknown error', action: 'Failed to create reply.', context: { postId, parentReplyId } });
	return Response.json({ id: data.id, parentReplyId: data.parent_reply_id, createdAt: data.created_at }, { status: 201 });
};
