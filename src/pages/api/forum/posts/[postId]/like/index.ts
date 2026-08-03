import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getSupabaseAdmin } from '../../../../../../lib/supabase/admin';

export const prerender = false;

export const POST: APIRoute = async ({ params, locals }) => {
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
	if (postError) return new Response(`Failed to read post: ${postError.message}`, { status: 500 });
	if (!post) return new Response('Post not found', { status: 404 });
	if (post.deleted_at) return new Response('Deleted posts cannot be liked', { status: 409 });
	if (existingError) return new Response(`Failed to read like: ${existingError.message}`, { status: 500 });

	let liked: boolean;
	if (existing) {
		const { error } = await locals.supabase
			.from('forum_post_likes')
			.delete()
			.eq('post_id', postId)
			.eq('user_id', locals.user.id);
		if (error) return new Response(`Failed to remove like: ${error.message}`, { status: 500 });
		liked = false;
	} else {
		const { error } = await locals.supabase
			.from('forum_post_likes')
			.insert({ post_id: postId, user_id: locals.user.id });
		if (error) return new Response(`Failed to add like: ${error.message}`, { status: 500 });
		liked = true;
	}

	const { count, error: countError } = await getSupabaseAdmin(env)
		.from('forum_post_likes')
		.select('post_id', { count: 'exact', head: true })
		.eq('post_id', postId);
	if (countError) return new Response(`Failed to count likes: ${countError.message}`, { status: 500 });
	return Response.json({ liked, likeCount: count ?? 0 });
};
