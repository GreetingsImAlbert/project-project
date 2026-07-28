import type { APIRoute } from 'astro';
import { canEditMoney } from '../../../../lib/money-access';
import { buildBulkRows, lineRows } from '../../../../lib/bulk-transaction';
import { TRANSACTION_COLUMNS } from '../../../../lib/transaction-columns';
import { resolveParty } from '../../../../lib/ghost-members';

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

	const { project_id: _projectId, ...parentFields } = built.parent;

	const { data: parent, error: parentError } = await locals.supabase
		.from('transactions')
		.update(parentFields)
		.eq('id', transactionId)
		.select(TRANSACTION_COLUMNS)
		.single();

	if (parentError || !parent) {
		return new Response(`Failed to update transaction: ${parentError?.message ?? 'unknown error'}`, { status: 500 });
	}

	// Lines are rewritten wholesale rather than diffed: the form hands back the full
	// list every time, and matching old rows to new ones would only add a way for the
	// parent's total and its own breakdown to drift apart. Delete-then-insert (rather
	// than the reverse) means a failed insert leaves the row short of its breakdown but
	// still carrying the right amount — re-saving the form fixes it.
	const { error: deleteError } = await locals.supabase.from('transactions').delete().eq('group_id', transactionId);

	if (deleteError) {
		return new Response(`Failed to replace transaction items: ${deleteError.message}`, { status: 500 });
	}

	const { data: lines, error: linesError } = await locals.supabase
		.from('transactions')
		.insert(lineRows(built.lines, transactionId!, existing.project_id, built.partyId, built.parent.transaction_date))
		.select(TRANSACTION_COLUMNS);

	if (linesError || !lines) {
		return new Response(`Failed to save transaction items: ${linesError?.message ?? 'unknown error'}`, { status: 500 });
	}

	return Response.json({ parent, lines });
};
