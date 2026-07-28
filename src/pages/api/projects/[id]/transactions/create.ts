import type { APIRoute } from 'astro';
import { canEditMoney } from '../../../../../lib/money-access';
import { itemUrlError } from '../../../../../lib/item-url';
import { transactionDateError } from '../../../../../lib/transaction-date';
import { TRANSACTION_COLUMNS } from '../../../../../lib/transaction-columns';
import { resolveParty } from '../../../../../lib/ghost-members';
import { partyColumns, relatedPartyColumns } from '../../../../../lib/money-parties';

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

	if (!(await resolveParty(locals.supabase, projectId!, partyId))) {
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

		if (!(await resolveParty(locals.supabase, projectId!, relatedPartyId))) {
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

	const { data: created, error } = await locals.supabase
		.from('transactions')
		.insert({
			project_id: projectId,
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
		.select(TRANSACTION_COLUMNS)
		.single();

	if (error) {
		return new Response(`Failed to create transaction: ${error.message}`, { status: 500 });
	}

	return Response.json(created);
};
