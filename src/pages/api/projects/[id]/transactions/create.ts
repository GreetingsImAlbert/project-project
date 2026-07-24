import type { APIRoute } from 'astro';

export const prerender = false;

const TYPES = ['item', 'shipping', 'discount', 'refund'];

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
	const transactionDate = formData.get('transactionDate')?.toString().trim();
	const type = formData.get('type')?.toString().trim();
	const memberId = formData.get('memberId')?.toString().trim();
	const itemName = formData.get('itemName')?.toString().trim() || null;
	const unit = formData.get('unit')?.toString().trim() || null;

	if (!transactionDate) {
		return new Response('Date is required', { status: 400 });
	}
	if (!type || !TYPES.includes(type)) {
		return new Response('Invalid transaction type', { status: 400 });
	}
	if (!memberId) {
		return new Response('Member is required', { status: 400 });
	}

	const { data: memberCheck } = await locals.supabase
		.from('project_members')
		.select('user_id')
		.eq('project_id', projectId)
		.eq('user_id', memberId)
		.single();

	if (!memberCheck) {
		return new Response('Invalid member', { status: 400 });
	}

	if (type === 'item' && itemName && itemName.length > 200) {
		return new Response('Item name: max 200 characters', { status: 400 });
	}
	if (type === 'item' && unit && unit.length > 50) {
		return new Response('Unit: max 50 characters', { status: 400 });
	}

	const quantity = type === 'item' ? parseNumeric(formData.get('quantity')) : 1;
	const unitCost = parseNumeric(formData.get('unitCost'));

	if (Number.isNaN(quantity) || Number.isNaN(unitCost)) {
		return new Response('Quantity and unit cost must be numbers', { status: 400 });
	}
	if (unitCost == null) {
		return new Response('Unit cost is required', { status: 400 });
	}
	if ((quantity ?? 0) < 0 || unitCost < 0) {
		return new Response('Cannot be negative', { status: 400 });
	}

	const { data: created, error } = await locals.supabase
		.from('transactions')
		.insert({
			project_id: projectId,
			member_id: memberId,
			transaction_date: transactionDate,
			type,
			item_name: type === 'item' ? itemName : null,
			quantity,
			unit: type === 'item' ? unit : null,
			unit_cost: unitCost,
		})
		.select('id, transaction_date, type, item_name, quantity, unit, unit_cost, total_cost, member_id, profiles(display_name)')
		.single();

	if (error) {
		return new Response(`Failed to create transaction: ${error.message}`, { status: 500 });
	}

	return Response.json(created);
};
