import type { APIRoute } from 'astro';
import { canEditMoney } from '../../../../../../lib/money-access';
import { errorResponse } from '../../../../../../lib/error-report';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const projectId = params.id;
	const memberId = params.userId;

	if (!(await canEditMoney(locals.supabase, projectId!, locals.user.id))) {
		return new Response('Forbidden', { status: 403 });
	}

	const formData = await request.formData();
	const raw = formData.get('contributionPercent')?.toString().trim();

	if (!raw) {
		return new Response('Contribution percent is required', { status: 400 });
	}

	const contributionPercent = Number(raw);

	if (!Number.isFinite(contributionPercent) || contributionPercent < 0 || contributionPercent > 100) {
		return new Response('Must be between 0 and 100', { status: 400 });
	}

	const { data: updated, error } = await locals.supabase
		.from('project_members')
		.update({ contribution_percent: contributionPercent })
		.eq('project_id', projectId)
		.eq('user_id', memberId)
		.select('user_id, contribution_percent')
		.single();

	if (error) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to update contribution: ${error.message}`,
			action: 'Failed to update contribution.',
			context: { projectId: projectId ?? null, memberId: memberId ?? null },
		});
	}

	return Response.json(updated);
};
