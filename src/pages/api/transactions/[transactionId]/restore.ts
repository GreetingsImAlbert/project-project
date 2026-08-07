import type { APIRoute } from 'astro';
import { canEditMoney } from '../../../../lib/money-access';
import { errorResponse } from '../../../../lib/error-report';

export const prerender = false;

// Undoes delete.ts — restoring a bulk parent restores its lines with it.
export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const transactionId = params.transactionId;

	const { data: transaction, error: transactionError } = await locals.supabase
		.from('transactions')
		.select('project_id, group_id, deleted_at')
		.eq('id', transactionId)
		.single();

	if (transactionError || !transaction) {
		return new Response('Transaction not found', { status: 404 });
	}

	if (!transaction.deleted_at) {
		return new Response('Transaction is not in the trash', { status: 400 });
	}

	if (transaction.group_id) {
		return new Response('Restore this item from its bulk transaction', { status: 400 });
	}

	if (!(await canEditMoney(locals.supabase, transaction.project_id, locals.user.id))) {
		return new Response('Forbidden', { status: 403 });
	}

	const { error } = await locals.supabase.rpc('set_transaction_deleted', {
		p_transaction_id: transactionId!,
		p_deleted_at: null,
	});

	if (error) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to restore transaction: ${error.message}`,
			action: 'Failed to restore transaction.',
			context: { transactionId: transactionId ?? null, projectId: transaction.project_id },
		});
	}

	return new Response(null, { status: 204 });
};
