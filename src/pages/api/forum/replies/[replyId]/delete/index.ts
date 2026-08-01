import type { APIRoute } from 'astro';

export const prerender = false;

export const POST: APIRoute = async ({ params, locals }) => {
	if (!locals.user) return new Response('Unauthorized', { status: 401 });
	const replyId = params.replyId;
	if (!replyId) return new Response('Reply not found', { status: 404 });

	const { data, error } = await locals.supabase
		.from('forum_replies')
		.update({ deleted_at: new Date().toISOString() })
		.eq('id', replyId)
		.eq('author_id', locals.user.id)
		.is('deleted_at', null)
		.select('id')
		.maybeSingle();

	if (error) return new Response(`Failed to delete reply: ${error.message}`, { status: 500 });
	if (!data) return new Response('Reply not found or not yours', { status: 404 });
	return Response.json({ deleted: true });
};
