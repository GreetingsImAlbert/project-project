import type { APIRoute } from 'astro';
import { canEditMoney } from '../../../../../lib/money-access';
import { buildBulkRows } from '../../../../../lib/bulk-transaction';
import { TRANSACTION_COLUMNS } from '../../../../../lib/transaction-columns';
import { resolveParty } from '../../../../../lib/ghost-members';
import type { Json } from '../../../../../lib/supabase/database.types';
import { errorResponse } from '../../../../../lib/error-report';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const projectId = params.id;

	if (!(await canEditMoney(locals.supabase, projectId!, locals.user.id))) {
		return new Response('Forbidden', { status: 403 });
	}

	let payload: unknown;
	try {
		payload = await request.json();
	} catch {
		return new Response('Invalid request body', { status: 400 });
	}

	const built = buildBulkRows(payload, projectId!);

	if ('error' in built) {
		return new Response(built.error, { status: 400 });
	}

	if (!(await resolveParty(locals.supabase, projectId!, built.partyId))) {
		return new Response('Invalid member', { status: 400 });
	}

	const { data: parentId, error: transactionError } = await locals.supabase.rpc('create_bulk_transaction_with_lines', {
		p_project_id: projectId!,
		p_member_id: built.parent.member_id,
		p_ghost_member_id: built.parent.ghost_member_id,
		p_transaction_date: built.parent.transaction_date,
		p_label: built.parent.item_name,
		p_total: built.total,
		p_supplier: built.parent.supplier,
		p_item_url: built.parent.item_url,
		p_lines: built.lines as unknown as Json,
	});

	if (transactionError || !parentId) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to create transaction: ${transactionError?.message ?? 'unknown error'}`,
			action: 'Failed to create transaction.',
			context: { projectId: projectId ?? null },
		});
	}

	const { data: rows, error: readError } = await locals.supabase
		.from('transactions')
		.select(TRANSACTION_COLUMNS)
		.or(`id.eq.${parentId},group_id.eq.${parentId}`)
		.order('created_at', { ascending: true });

	const parent = rows?.find((row) => row.id === parentId);
	const lines = rows?.filter((row) => row.group_id === parentId) ?? [];

	if (readError || !parent) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Transaction created but could not be read back: ${readError?.message ?? 'unknown error'}`,
			action: 'Transaction created but could not be read back.',
			context: { projectId: projectId ?? null, parentId: parentId ?? null },
		});
	}

	return Response.json({ parent, lines });
};
