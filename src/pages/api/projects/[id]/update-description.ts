import type { APIRoute } from 'astro';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const projectId = params.id;

	const { data: membership } = await locals.supabase
		.from('project_members')
		.select('role')
		.eq('project_id', projectId)
		.eq('user_id', locals.user.id)
		.single();

	if (!membership || membership.role !== 'owner') {
		return new Response('Forbidden', { status: 403 });
	}

	const formData = await request.formData();
	const description = formData.get('description')?.toString().trim() || null;

	if (description && description.length > 2000) {
		return new Response('Description must be 2000 characters or fewer', { status: 400 });
	}

	const { data: updated, error } = await locals.supabase
		.from('projects')
		.update({ description })
		.eq('id', projectId)
		.select('id, description')
		.single();

	if (error) {
		return new Response(`Failed to update description: ${error.message}`, { status: 500 });
	}

	return Response.json(updated);
};
