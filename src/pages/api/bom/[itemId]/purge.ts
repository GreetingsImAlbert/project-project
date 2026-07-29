import type { APIRoute } from 'astro';
import { canEditMoney } from '../../../../lib/money-access';

export const prerender = false;

// Permanent delete — the "delete forever" action from the Trash page.
export const POST: APIRoute = async ({ params, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const itemId = params.itemId;

	const { data: item, error: itemError } = await locals.supabase
		.from('bom_items')
		.select('project_id, deleted_at')
		.eq('id', itemId)
		.single();

	if (itemError || !item) {
		return new Response('BOM item not found', { status: 404 });
	}

	if (!item.deleted_at) {
		return new Response('BOM item is not in the trash', { status: 400 });
	}

	if (!(await canEditMoney(locals.supabase, item.project_id, locals.user.id))) {
		return new Response('Forbidden', { status: 403 });
	}

	const { error } = await locals.supabase.from('bom_items').delete().eq('id', itemId);

	if (error) {
		return new Response(`Failed to delete BOM item: ${error.message}`, { status: 500 });
	}

	return new Response(null, { status: 204 });
};
