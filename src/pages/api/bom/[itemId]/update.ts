import type { APIRoute } from 'astro';

export const prerender = false;

function parseNumeric(value: FormDataEntryValue | null): number | null {
	const str = value?.toString().trim();
	if (!str) return null;
	const num = Number(str);
	return Number.isFinite(num) ? num : NaN;
}

export const POST: APIRoute = async ({ params, request, locals, redirect }) => {
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

	const { data: membership } = await locals.supabase
		.from('project_members')
		.select('role')
		.eq('project_id', item.project_id)
		.eq('user_id', locals.user.id)
		.single();

	if (!membership || !['owner', 'editor'].includes(membership.role)) {
		return new Response('Forbidden', { status: 403 });
	}

	const formData = await request.formData();
	const partName = formData.get('partName')?.toString().trim();
	const description = formData.get('description')?.toString().trim() || null;
	const unit = formData.get('unit')?.toString().trim() || null;
	const supplier = formData.get('supplier')?.toString().trim() || null;
	const itemUrl = formData.get('itemUrl')?.toString().trim() || null;

	if (!partName) {
		return new Response('Part name is required', { status: 400 });
	}

	if (partName.length > 200) {
		return new Response('Part name must be 200 characters or fewer', { status: 400 });
	}
	if (description && description.length > 1000) {
		return new Response('Description must be 1000 characters or fewer', { status: 400 });
	}
	if (unit && unit.length > 50) {
		return new Response('Unit must be 50 characters or fewer', { status: 400 });
	}
	if (supplier && supplier.length > 200) {
		return new Response('Supplier must be 200 characters or fewer', { status: 400 });
	}

	const quantity = parseNumeric(formData.get('quantity'));
	const unitCost = parseNumeric(formData.get('unitCost'));

	if (Number.isNaN(quantity) || Number.isNaN(unitCost)) {
		return new Response('Quantity and unit cost must be numbers', { status: 400 });
	}

	if ((quantity ?? 0) < 0 || (unitCost ?? 0) < 0) {
		return new Response('Quantity and unit cost cannot be negative', { status: 400 });
	}

	if (itemUrl) {
		let parsedUrl: URL;
		try {
			parsedUrl = new URL(itemUrl);
		} catch {
			return new Response('Item URL must be a valid URL', { status: 400 });
		}
		if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
			return new Response('Item URL must use http or https', { status: 400 });
		}
	}

	const { error } = await locals.supabase
		.from('bom_items')
		.update({
			part_name: partName,
			description,
			quantity,
			unit,
			unit_cost: unitCost,
			supplier,
			item_url: itemUrl,
		})
		.eq('id', itemId);

	if (error) {
		return new Response(`Failed to update BOM item: ${error.message}`, { status: 500 });
	}

	return redirect(`/projects/${item.project_id}`);
};