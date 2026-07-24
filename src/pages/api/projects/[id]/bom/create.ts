import type { APIRoute } from 'astro';

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

	const projectId = params.id;

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

	if (itemUrl) {
		let parsedUrl: URL;
		try {
			parsedUrl = new URL(itemUrl);
		} catch {
			return new Response('Invalid item URL', { status: 400 });
		}
		if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
			return new Response('URL must be http or https', { status: 400 });
		}
	}

	const { data: created, error } = await locals.supabase
		.from('bom_items')
		.insert({
			project_id: projectId,
			part_name: partName,
			category,
			description,
			quantity,
			unit,
			unit_cost: unitCost,
			supplier,
			item_url: itemUrl,
		})
		.select('id, part_name, category, description, quantity, unit, unit_cost, supplier, item_url, total_cost')
		.single();

	if (error) {
		return new Response(`Failed to create BOM item: ${error.message}`, { status: 500 });
	}

	return Response.json(created);
};