import type { APIRoute } from 'astro';
import { canEditMoney } from '../../../../../lib/money-access';
import { buildBulkRows, lineRows } from '../../../../../lib/bulk-transaction';
import { TRANSACTION_COLUMNS } from '../../../../../lib/transaction-columns';

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

	const memberId = built.parent.member_id as string;

	const { data: memberCheck } = await locals.supabase
		.from('project_members')
		.select('user_id')
		.eq('project_id', projectId)
		.eq('user_id', memberId)
		.single();

	if (!memberCheck) {
		return new Response('Invalid member', { status: 400 });
	}

	const { data: parent, error: parentError } = await locals.supabase
		.from('transactions')
		.insert(built.parent as never)
		.select(TRANSACTION_COLUMNS)
		.single();

	if (parentError || !parent) {
		return new Response(`Failed to create transaction: ${parentError?.message ?? 'unknown error'}`, { status: 500 });
	}

	const parentId = (parent as unknown as { id: string }).id;

	const { data: lines, error: linesError } = await locals.supabase
		.from('transactions')
		.insert(
			lineRows(built.lines, parentId, projectId!, memberId, built.parent.transaction_date as string) as never,
		)
		.select(TRANSACTION_COLUMNS);

	// No transaction across the two inserts — a parent with no lines would show as an
	// empty bulk row, so undo it rather than leave that behind.
	if (linesError || !lines) {
		await locals.supabase.from('transactions').delete().eq('id', parentId);
		return new Response(`Failed to create transaction items: ${linesError?.message ?? 'unknown error'}`, { status: 500 });
	}

	return Response.json({ parent, lines });
};
