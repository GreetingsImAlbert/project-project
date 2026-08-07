import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { errorResponse } from '../../../../../../lib/error-report';
import { getSupabaseAdmin } from '../../../../../../lib/supabase/admin';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) return new Response('Unauthorized', { status: 401 });
	const replyId = params.replyId;
	if (!replyId) return new Response('Reply not found', { status: 404 });

	const { data: reply, error: replyError } = await locals.supabase
		.from('forum_replies')
		.select('id, post_id, deleted_at')
		.eq('id', replyId)
		.maybeSingle();
	if (replyError) return errorResponse({ request, userId: locals.user.id, privateMessage: replyError.message, action: 'Failed to read reply.', context: { replyId } });
	if (!reply) return new Response('Reply not found', { status: 404 });
	if (reply.deleted_at) return new Response('Deleted replies cannot be liked', { status: 409 });

	// Once the reply gives us its post id, post validity and this user's like state
	// are independent reads and can share the round trip.
	const [{ data: post, error: postError }, { data: existing, error: existingError }] = await Promise.all([
		locals.supabase
			.from('forum_posts')
			.select('id, deleted_at')
			.eq('id', reply.post_id)
			.maybeSingle(),
		locals.supabase
			.from('forum_reply_likes')
			.select('reply_id')
			.eq('reply_id', replyId)
			.eq('user_id', locals.user.id)
			.maybeSingle(),
	]);
	if (postError) return errorResponse({ request, userId: locals.user.id, privateMessage: postError.message, action: 'Failed to read post.', context: { replyId, postId: reply.post_id } });
	if (!post || post.deleted_at) return new Response('Replies to deleted posts cannot be liked', { status: 409 });
	if (existingError) return errorResponse({ request, userId: locals.user.id, privateMessage: existingError.message, action: 'Failed to read like.', context: { replyId } });

	let liked: boolean;
	if (existing) {
		const { error } = await locals.supabase
			.from('forum_reply_likes')
			.delete()
			.eq('reply_id', replyId)
			.eq('user_id', locals.user.id);
		if (error) return errorResponse({ request, userId: locals.user.id, privateMessage: error.message, action: 'Failed to remove like.', context: { replyId } });
		liked = false;
	} else {
		const { error } = await locals.supabase
			.from('forum_reply_likes')
			.insert({ reply_id: replyId, user_id: locals.user.id });
		if (error) return errorResponse({ request, userId: locals.user.id, privateMessage: error.message, action: 'Failed to add like.', context: { replyId } });
		liked = true;
	}

	const { count, error: countError } = await getSupabaseAdmin(env)
		.from('forum_reply_likes')
		.select('reply_id', { count: 'exact', head: true })
		.eq('reply_id', replyId);
	if (countError) return errorResponse({ request, userId: locals.user.id, privateMessage: countError.message, action: 'Failed to count likes.', context: { replyId } });
	return Response.json({ liked, likeCount: count ?? 0 });
};
