import type { APIRoute } from 'astro';
import { CURRENCIES } from '../../../../lib/currency';
import { errorResponse } from '../../../../lib/error-report';

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
	const currency = formData.get('currency')?.toString();

	if (!currency || !(CURRENCIES as readonly string[]).includes(currency)) {
		return new Response('Invalid currency', { status: 400 });
	}

	const { error } = await locals.supabase
		.from('projects')
		.update({ currency })
		.eq('id', projectId);

	if (error) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to update currency: ${error.message}`,
			action: 'Failed to update currency.',
			context: { projectId: projectId ?? null },
		});
	}

	return new Response(null, { status: 204 });
};
