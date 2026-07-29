import type { APIRoute } from 'astro';
import { canEditMoney } from '../../../../lib/money-access';

export const prerender = false;

// Undoes delete.ts — restoring a bulk parent restores its lines with it.
export const POST: APIRoute = async ({ params, locals }) => {
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

	const { error } = await locals.supabase.from('transactions').update({ deleted_at: null }).eq('id', transactionId);

	if (error) {
		return new Response(`Failed to restore transaction: ${error.message}`, { status: 500 });
	}

	await locals.supabase.from('transactions').update({ deleted_at: null }).eq('group_id', transactionId);

	return new Response(null, { status: 204 });
};
