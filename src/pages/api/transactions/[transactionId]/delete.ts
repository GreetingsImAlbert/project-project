import type { APIRoute } from 'astro';
import { canEditMoney } from '../../../../lib/money-access';

export const prerender = false;

export const POST: APIRoute = async ({ params, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const transactionId = params.transactionId;

	const { data: transaction, error: transactionError } = await locals.supabase
		.from('transactions')
		.select('project_id, group_id')
		.eq('id', transactionId)
		.single();

	if (transactionError || !transaction) {
		return new Response('Transaction not found', { status: 404 });
	}

	// A line belongs to its bulk parent, which carries the whole amount — dropping one
	// line on its own would leave the parent's total standing on a breakdown that no
	// longer adds up to it. Deleting the parent takes the lines with it (FK cascade).
	if (transaction.group_id) {
		return new Response('Delete this item from its bulk transaction', { status: 400 });
	}

	if (!(await canEditMoney(locals.supabase, transaction.project_id, locals.user.id))) {
		return new Response('Forbidden', { status: 403 });
	}

	const { error } = await locals.supabase.from('transactions').delete().eq('id', transactionId);

	if (error) {
		return new Response(`Failed to delete transaction: ${error.message}`, { status: 500 });
	}

	return new Response(null, { status: 204 });
};
