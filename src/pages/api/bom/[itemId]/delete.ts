import type { APIRoute } from 'astro';
import { canEditMoney } from '../../../../lib/money-access';
import { errorResponse } from '../../../../lib/error-report';

export const prerender = false;

// Soft-delete — moves the item to the project's Trash instead of removing it.
export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const itemId = params.itemId;

	const { data: item, error: itemError } = await locals.supabase
		.from('bom_items')
		.select('project_id')
		.eq('id', itemId)
		.single();

	if (itemError || !item) {
		return new Response('BOM item not found', { status: 404 });
	}

	if (!(await canEditMoney(locals.supabase, item.project_id, locals.user.id))) {
		return new Response('Forbidden', { status: 403 });
	}

	const { error } = await locals.supabase.from('bom_items').update({ deleted_at: new Date().toISOString() }).eq('id', itemId);

	if (error) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to delete BOM item: ${error.message}`,
			action: 'Failed to delete BOM item.',
			context: { itemId: itemId ?? null, projectId: item.project_id },
		});
	}

	return new Response(null, { status: 204 });
};