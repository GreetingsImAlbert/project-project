import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { errorResponse } from '../../../../../../lib/error-report';
import { getSupabaseAdmin } from '../../../../../../lib/supabase/admin';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) return new Response('Unauthorized', { status: 401 });
	const postId = params.postId;
	if (!postId) return new Response('Post not found', { status: 404 });

	// Post validity and this user's current like are independent reads. Run them
	// together; the mutation below still waits for both before changing state.
	const [{ data: post, error: postError }, { data: existing, error: existingError }] = await Promise.all([
		locals.supabase
			.from('forum_posts')
			.select('id, deleted_at')
			.eq('id', postId)
			.maybeSingle(),
		locals.supabase
			.from('forum_post_likes')
			.select('post_id')
			.eq('post_id', postId)
			.eq('user_id', locals.user.id)
			.maybeSingle(),
	]);
	if (postError) return errorResponse({ request, userId: locals.user.id, privateMessage: postError.message, action: 'Failed to read post.', context: { postId } });
	if (!post) return new Response('Post not found', { status: 404 });
	if (post.deleted_at) return new Response('Deleted posts cannot be liked', { status: 409 });
	if (existingError) return errorResponse({ request, userId: locals.user.id, privateMessage: existingError.message, action: 'Failed to read like.', context: { postId } });

	let liked: boolean;
	if (existing) {
		const { error } = await locals.supabase
			.from('forum_post_likes')
			.delete()
			.eq('post_id', postId)
			.eq('user_id', locals.user.id);
		if (error) return errorResponse({ request, userId: locals.user.id, privateMessage: error.message, action: 'Failed to remove like.', context: { postId } });
		liked = false;
	} else {
		const { error } = await locals.supabase
			.from('forum_post_likes')
			.insert({ post_id: postId, user_id: locals.user.id });
		if (error) return errorResponse({ request, userId: locals.user.id, privateMessage: error.message, action: 'Failed to add like.', context: { postId } });
		liked = true;
	}

	const { count, error: countError } = await getSupabaseAdmin(env)
		.from('forum_post_likes')
		.select('post_id', { count: 'exact', head: true })
		.eq('post_id', postId);
	if (countError) return errorResponse({ request, userId: locals.user.id, privateMessage: countError.message, action: 'Failed to count likes.', context: { postId } });
	return Response.json({ liked, likeCount: count ?? 0 });
};
