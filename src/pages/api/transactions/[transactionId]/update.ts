import type { APIRoute } from 'astro';
import { canEditMoney } from '../../../../lib/money-access';
import { itemUrlError } from '../../../../lib/item-url';
import { transactionDateError } from '../../../../lib/transaction-date';
import { TRANSACTION_COLUMNS } from '../../../../lib/transaction-columns';
import { resolveParty } from '../../../../lib/ghost-members';
import { partyColumns, relatedPartyColumns } from '../../../../lib/money-parties';
import { errorResponse } from '../../../../lib/error-report';

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

	const transactionId = params.transactionId;

	const { data: transaction, error: transactionError } = await locals.supabase
		.from('transactions')
		.select('project_id, type, group_id')
		.eq('id', transactionId)
		.single();

	if (transactionError || !transaction) {
		return new Response('Transaction not found', { status: 404 });
	}

	// A bulk row's amount is derived from its lines — editing it through the
	// single-transaction form would leave the two disagreeing. The same goes the other
	// way for one of its lines: the parent carries the money, so a line edited on its
	// own would no longer add up to it.
	if (transaction.type === 'bulk') {
		return new Response('Edit this bulk transaction from its own form', { status: 400 });
	}
	if (transaction.group_id) {
		return new Response('Edit this item from its bulk transaction', { status: 400 });
	}

	if (!(await canEditMoney(locals.supabase, transaction.project_id, locals.user.id))) {
		return new Response('Forbidden', { status: 403 });
	}

	const formData = await request.formData();
	const transactionDate = formData.get('transactionDate')?.toString().trim();
	const type = formData.get('type')?.toString().trim();
	// A party id is either a member's user id or a ghost member's prefixed id — see
	// money-parties.ts.
	const partyId = formData.get('partyId')?.toString().trim();
	const itemName = formData.get('itemName')?.toString().trim() || null;
	const unit = formData.get('unit')?.toString().trim() || null;
	const supplier = formData.get('supplier')?.toString().trim() || null;
	const itemUrl = formData.get('itemUrl')?.toString().trim() || null;
	const relatedPartyId = formData.get('relatedPartyId')?.toString().trim() || null;

	const dateError = transactionDateError(transactionDate);
	if (dateError) {
		return new Response(dateError, { status: 400 });
	}
	if (!type || !TYPES.includes(type)) {
		return new Response('Invalid transaction type', { status: 400 });
	}
	if (!partyId) {
		return new Response('Member is required', { status: 400 });
	}

	if (!(await resolveParty(locals.supabase, transaction.project_id, partyId))) {
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

	const urlError = itemUrlError(itemUrl);
	if (urlError) {
		return new Response(urlError, { status: 400 });
	}

	if (type === 'payment') {
		if (!relatedPartyId) {
			return new Response('Payee is required', { status: 400 });
		}
		if (relatedPartyId === partyId) {
			return new Response('Cannot pay yourself', { status: 400 });
		}

		if (!(await resolveParty(locals.supabase, transaction.project_id, relatedPartyId))) {
			return new Response('Invalid payee', { status: 400 });
		}
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

	const { data: updated, error } = await locals.supabase
		.from('transactions')
		.update({
			...partyColumns(partyId),
			...relatedPartyColumns(type === 'payment' ? relatedPartyId : null),
			transaction_date: transactionDate,
			type,
			// A payment's label is derived from the payee's party id at display time (see
			// TransactionsTable/MemberContributionsTable), so a renamed payee doesn't leave
			// a stale name baked into old rows.
			item_name: type === 'item' ? itemName : null,
			quantity,
			unit: type === 'item' ? unit : null,
			unit_cost: unitCost,
			// A member-to-member payment has no supplier; every other type can.
			supplier: type === 'payment' ? null : supplier,
			item_url: type === 'payment' ? null : itemUrl,
		})
		.eq('id', transactionId)
		.select(TRANSACTION_COLUMNS)
		.single();

	if (error) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to update transaction: ${error.message}`,
			action: 'Failed to update transaction.',
			context: { transactionId: transactionId ?? null, projectId: transaction.project_id },
		});
	}

	return Response.json(updated);
};
