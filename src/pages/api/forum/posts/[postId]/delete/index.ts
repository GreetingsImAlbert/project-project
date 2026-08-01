import type { APIRoute } from 'astro';

export const prerender = false;

export const POST: APIRoute = async ({ params, locals }) => {
	if (!locals.user) return new Response('Unauthorized', { status: 401 });
	const postId = params.postId;
	if (!postId) return new Response('Post not found', { status: 404 });

	const { data, error } = await locals.supabase
		.from('forum_posts')
		.update({ deleted_at: new Date().toISOString() })
		.eq('id', postId)
		.eq('author_id', locals.user.id)
		.is('deleted_at', null)
		.select('id')
		.maybeSingle();

	if (error) return new Response(`Failed to delete post: ${error.message}`, { status: 500 });
	if (!data) return new Response('Post not found or not yours', { status: 404 });
	return Response.json({ deleted: true });
};
