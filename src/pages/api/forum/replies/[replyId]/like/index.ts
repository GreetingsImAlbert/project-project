import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getSupabaseAdmin } from '../../../../../../lib/supabase/admin';

export const prerender = false;

export const POST: APIRoute = async ({ params, locals }) => {
	if (!locals.user) return new Response('Unauthorized', { status: 401 });
	const replyId = params.replyId;
	if (!replyId) return new Response('Reply not found', { status: 404 });

	const { data: reply, error: replyError } = await locals.supabase
		.from('forum_replies')
		.select('id, post_id, deleted_at')
		.eq('id', replyId)
		.maybeSingle();
	if (replyError) return new Response(`Failed to read reply: ${replyError.message}`, { status: 500 });
	if (!reply) return new Response('Reply not found', { status: 404 });
	if (reply.deleted_at) return new Response('Deleted replies cannot be liked', { status: 409 });

	const { data: post, error: postError } = await locals.supabase
		.from('forum_posts')
		.select('id, deleted_at')
		.eq('id', reply.post_id)
		.maybeSingle();
	if (postError) return new Response(`Failed to read post: ${postError.message}`, { status: 500 });
	if (!post || post.deleted_at) return new Response('Replies to deleted posts cannot be liked', { status: 409 });

	const { data: existing, error: existingError } = await locals.supabase
		.from('forum_reply_likes')
		.select('reply_id')
		.eq('reply_id', replyId)
		.eq('user_id', locals.user.id)
		.maybeSingle();
	if (existingError) return new Response(`Failed to read like: ${existingError.message}`, { status: 500 });

	let liked: boolean;
	if (existing) {
		const { error } = await locals.supabase
			.from('forum_reply_likes')
			.delete()
			.eq('reply_id', replyId)
			.eq('user_id', locals.user.id);
		if (error) return new Response(`Failed to remove like: ${error.message}`, { status: 500 });
		liked = false;
	} else {
		const { error } = await locals.supabase
			.from('forum_reply_likes')
			.insert({ reply_id: replyId, user_id: locals.user.id });
		if (error) return new Response(`Failed to add like: ${error.message}`, { status: 500 });
		liked = true;
	}

	const { count, error: countError } = await getSupabaseAdmin(env)
		.from('forum_reply_likes')
		.select('reply_id', { count: 'exact', head: true })
		.eq('reply_id', replyId);
	if (countError) return new Response(`Failed to count likes: ${countError.message}`, { status: 500 });
	return Response.json({ liked, likeCount: count ?? 0 });
};
