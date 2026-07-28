import type { APIRoute } from 'astro';

export const prerender = false;

export const POST: APIRoute = async ({ params, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const projectId = params.id;
	const memberId = params.userId;

	// only the owner can remove members
	const { data: project } = await locals.supabase
		.from('projects')
		.select('owner_id')
		.eq('id', projectId)
		.single();

	if (!project || project.owner_id !== locals.user.id) {
		return new Response('Forbidden', { status: 403 });
	}

	if (memberId === project.owner_id) {
		return new Response('Cannot remove the project owner', { status: 400 });
	}

	const { error } = await locals.supabase
		.from('project_members')
		.delete()
		.eq('project_id', projectId)
		.eq('user_id', memberId);

	if (error) {
		return new Response(`Failed to remove member: ${error.message}`, { status: 500 });
	}

	return new Response(null, { status: 204 });
};
