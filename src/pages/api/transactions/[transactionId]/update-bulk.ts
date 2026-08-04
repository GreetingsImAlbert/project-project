import type { APIRoute } from 'astro';
import { canEditMoney } from '../../../../lib/money-access';
import { buildBulkRows } from '../../../../lib/bulk-transaction';
import { TRANSACTION_COLUMNS } from '../../../../lib/transaction-columns';
import { resolveParty } from '../../../../lib/ghost-members';
import type { Json } from '../../../../lib/supabase/database.types';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const transactionId = params.transactionId;

	const { data: existing, error: existingError } = await locals.supabase
		.from('transactions')
		.select('project_id, type')
		.eq('id', transactionId)
		.single();

	if (existingError || !existing) {
		return new Response('Transaction not found', { status: 404 });
	}

	if (existing.type !== 'bulk') {
		return new Response('Not a bulk transaction', { status: 400 });
	}

	if (!(await canEditMoney(locals.supabase, existing.project_id, locals.user.id))) {
		return new Response('Forbidden', { status: 403 });
	}

	let payload: unknown;
	try {
		payload = await request.json();
	} catch {
		return new Response('Invalid request body', { status: 400 });
	}

	const built = buildBulkRows(payload, existing.project_id);

	if ('error' in built) {
		return new Response(built.error, { status: 400 });
	}

	if (!(await resolveParty(locals.supabase, existing.project_id, built.partyId))) {
		return new Response('Invalid member', { status: 400 });
	}

	const { error: transactionError } = await locals.supabase.rpc('replace_bulk_transaction_with_lines', {
		p_transaction_id: transactionId!,
		p_member_id: built.parent.member_id,
		p_ghost_member_id: built.parent.ghost_member_id,
		p_transaction_date: built.parent.transaction_date,
		p_label: built.parent.item_name,
		p_total: built.total,
		p_supplier: built.parent.supplier,
		p_item_url: built.parent.item_url,
		p_lines: built.lines as unknown as Json,
	});

	if (transactionError) {
		return new Response(`Failed to update transaction: ${transactionError.message}`, { status: 500 });
	}

	const { data: rows, error: readError } = await locals.supabase
		.from('transactions')
		.select(TRANSACTION_COLUMNS)
		.or(`id.eq.${transactionId},group_id.eq.${transactionId}`)
		.order('created_at', { ascending: true });

	const parent = rows?.find((row) => row.id === transactionId);
	const lines = rows?.filter((row) => row.group_id === transactionId) ?? [];

	if (readError || !parent) {
		return new Response(`Transaction updated but could not be read back: ${readError?.message ?? 'unknown error'}`, { status: 500 });
	}

	return Response.json({ parent, lines });
};
