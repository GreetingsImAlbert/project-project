import type { APIRoute } from 'astro';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const projectId = params.id;
	const memberId = params.userId;

	const { data: membership } = await locals.supabase
		.from('project_members')
		.select('role')
		.eq('project_id', projectId)
		.eq('user_id', locals.user.id)
		.single();

	if (!membership || !['owner', 'editor'].includes(membership.role)) {
		return new Response('Forbidden', { status: 403 });
	}

	const formData = await request.formData();
	const raw = formData.get('contributionPercent')?.toString().trim();

	if (!raw) {
		return new Response('Contribution percent is required', { status: 400 });
	}

	const contributionPercent = Number(raw);

	if (!Number.isFinite(contributionPercent) || contributionPercent < 0 || contributionPercent > 100) {
		return new Response('Contribution percent must be a number between 0 and 100', { status: 400 });
	}

	const { data: updated, error } = await locals.supabase
		.from('project_members')
		.update({ contribution_percent: contributionPercent })
		.eq('project_id', projectId)
		.eq('user_id', memberId)
		.select('user_id, contribution_percent')
		.single();

	if (error) {
		return new Response(`Failed to update contribution: ${error.message}`, { status: 500 });
	}

	return Response.json(updated);
};
