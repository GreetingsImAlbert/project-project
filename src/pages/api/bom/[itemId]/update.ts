import type { APIRoute } from 'astro';
import { canEditMoney } from '../../../../lib/money-access';
import { itemUrlError } from '../../../../lib/item-url';
import { errorResponse } from '../../../../lib/error-report';

export const prerender = false;

function parseNumeric(value: FormDataEntryValue | null): number | null {
	const str = value?.toString().trim();
	if (!str) return null;
	const num = Number(str);
	return Number.isFinite(num) ? num : NaN;
}

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

	const formData = await request.formData();
	const partName = formData.get('partName')?.toString().trim();
	const category = formData.get('category')?.toString().trim() || null;
	const description = formData.get('description')?.toString().trim() || null;
	const unit = formData.get('unit')?.toString().trim() || null;
	const supplier = formData.get('supplier')?.toString().trim() || null;
	const itemUrl = formData.get('itemUrl')?.toString().trim() || null;

	if (!partName) {
		return new Response('Part name is required', { status: 400 });
	}

	if (partName.length > 200) {
		return new Response('Part name: max 200 characters', { status: 400 });
	}
	if (category && category.length > 100) {
		return new Response('Category: max 100 characters', { status: 400 });
	}
	if (description && description.length > 1000) {
		return new Response('Description: max 1000 characters', { status: 400 });
	}
	if (unit && unit.length > 50) {
		return new Response('Unit: max 50 characters', { status: 400 });
	}
	if (supplier && supplier.length > 200) {
		return new Response('Supplier: max 200 characters', { status: 400 });
	}

	const quantity = parseNumeric(formData.get('quantity'));
	const unitCost = parseNumeric(formData.get('unitCost'));

	if (Number.isNaN(quantity) || Number.isNaN(unitCost)) {
		return new Response('Quantity and unit cost must be numbers', { status: 400 });
	}

	if ((quantity ?? 0) < 0 || (unitCost ?? 0) < 0) {
		return new Response('Cannot be negative', { status: 400 });
	}

	const urlError = itemUrlError(itemUrl);
	if (urlError) {
		return new Response(urlError, { status: 400 });
	}

	const { data: updated, error } = await locals.supabase
		.from('bom_items')
		.update({
			part_name: partName,
			category,
			description,
			quantity,
			unit,
			unit_cost: unitCost,
			supplier,
			item_url: itemUrl,
		})
		.eq('id', itemId)
		.select('id, part_name, category, description, quantity, unit, unit_cost, supplier, item_url, total_cost')
		.single();

	if (error) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to update BOM item: ${error.message}`,
			action: 'Failed to update BOM item.',
			context: { itemId: itemId ?? null, projectId: item.project_id },
		});
	}

	return Response.json(updated);
};