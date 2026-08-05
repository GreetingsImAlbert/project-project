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
	const name = formData.get('name')?.toString().trim() ?? '';

	if (!name) {
		return new Response('Project name is required', { status: 400 });
	}

	if (name.length > 200) {
		return new Response('Project name: max 200 characters', { status: 400 });
	}

	const { data: updated, error } = await locals.supabase
		.from('projects')
		.update({ name })
		.eq('id', projectId)
		.select('id, name')
		.single();

	if (error) {
		return new Response(`Failed to rename project: ${error.message}`, { status: 500 });
	}

	return Response.json(updated);
};
