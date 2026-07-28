import type { APIRoute } from 'astro';
import { canEditMoney } from '../../../../../../lib/money-access';

export const prerender = false;

export const POST: APIRoute = async ({ params, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const projectId = params.id;
	const ghostId = params.ghostId;

	if (!(await canEditMoney(locals.supabase, projectId!, locals.user.id))) {
		return new Response('Forbidden', { status: 403 });
	}

	// The FK is `on delete restrict`, so the database would reject this anyway — but a
	// raw constraint-violation message is no use to whoever clicked Delete. Counted
	// first so the answer says what's actually in the way. Lines of a bulk transaction
	// carry their parent's party, hence the count can exceed what the table shows.
	const { count, error: countError } = await locals.supabase
		.from('transactions')
		.select('id', { count: 'exact', head: true })
		.eq('project_id', projectId)
		.or(`ghost_member_id.eq.${ghostId},related_ghost_member_id.eq.${ghostId}`);

	if (countError) {
		return new Response(`Failed to delete ghost member: ${countError.message}`, { status: 500 });
	}
	if ((count ?? 0) > 0) {
		return new Response(
			'This ghost member is named on transactions — reassign or delete those first',
			{ status: 400 },
		);
	}

	const { error } = await locals.supabase
		.from('ghost_members')
		.delete()
		.eq('id', ghostId)
		.eq('project_id', projectId);

	if (error) {
		return new Response(`Failed to delete ghost member: ${error.message}`, { status: 500 });
	}

	return new Response(null, { status: 204 });
};
