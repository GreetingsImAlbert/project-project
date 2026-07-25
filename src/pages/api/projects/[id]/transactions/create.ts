import type { APIRoute } from 'astro';
import { canEditMoney } from '../../../../../lib/money-access';

export const prerender = false;

const TYPES = ['item', 'shipping', 'discount', 'refund', 'payment'];

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

	if (!(await canEditMoney(locals.supabase, projectId!, locals.user.id))) {
		return new Response('Forbidden', { status: 403 });
	}

	const formData = await request.formData();
	const transactionDate = formData.get('transactionDate')?.toString().trim();
	const type = formData.get('type')?.toString().trim();
	const memberId = formData.get('memberId')?.toString().trim();
	const itemName = formData.get('itemName')?.toString().trim() || null;
	const unit = formData.get('unit')?.toString().trim() || null;
	const supplier = formData.get('supplier')?.toString().trim() || null;
	const relatedMemberId = formData.get('relatedMemberId')?.toString().trim() || null;

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
	if (supplier && supplier.length > 200) {
		return new Response('Supplier: max 200 characters', { status: 400 });
	}

	let payeeDisplayName: string | null = null;
	if (type === 'payment') {
		if (!relatedMemberId) {
			return new Response('Payee is required', { status: 400 });
		}
		if (relatedMemberId === memberId) {
			return new Response('Cannot pay yourself', { status: 400 });
		}

		const { data: payeeCheck } = await locals.supabase
			.from('project_members')
			.select('user_id, profiles(display_name)')
			.eq('project_id', projectId)
			.eq('user_id', relatedMemberId)
			.single()
			.overrideTypes<{ user_id: string; profiles: { display_name: string } | null }>();

		if (!payeeCheck) {
			return new Response('Invalid payee', { status: 400 });
		}
		payeeDisplayName = payeeCheck.profiles?.display_name ?? null;
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
			related_member_id: type === 'payment' ? relatedMemberId : null,
			transaction_date: transactionDate,
			type,
			item_name: type === 'item' ? itemName : type === 'payment' ? `Pay ${payeeDisplayName ?? 'member'}` : null,
			quantity,
			unit: type === 'item' ? unit : null,
			unit_cost: unitCost,
			// A member-to-member payment has no supplier; every other type can.
			supplier: type === 'payment' ? null : supplier,
		})
		.select(
			'id, transaction_date, type, item_name, quantity, unit, unit_cost, supplier, total_cost, member_id, related_member_id, profiles!transactions_member_id_fkey(display_name)',
		)
		.single();

	if (error) {
		return new Response(`Failed to create transaction: ${error.message}`, { status: 500 });
	}

	return Response.json(created);
};
