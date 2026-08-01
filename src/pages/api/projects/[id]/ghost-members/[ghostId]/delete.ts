import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { canEditMoney } from '../../../../../../lib/money-access';
import { getSupabaseAdmin } from '../../../../../../lib/supabase/admin';

export const prerender = false;

export const POST: APIRoute = async ({ params, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const projectId = params.id;
	const ghostId = params.ghostId;
	if (!projectId || !ghostId) {
		return new Response('Project and ghost member are required', { status: 400 });
	}

	if (!(await canEditMoney(locals.supabase, projectId!, locals.user.id))) {
		return new Response('Forbidden', { status: 403 });
	}

	const admin = getSupabaseAdmin(env);
	const { data: ghost, error: ghostError } = await admin
		.from('ghost_members')
		.select('id')
		.eq('id', ghostId)
		.eq('project_id', projectId)
		.maybeSingle();

	if (ghostError) {
		return new Response(`Failed to find ghost member: ${ghostError.message}`, { status: 500 });
	}
	if (!ghost) {
		return new Response('Ghost member not found', { status: 404 });
	}

	// Both FKs are `on delete restrict`, so the database would reject this anyway —
	// but a raw constraint-violation message is no use to whoever clicked Delete.
	// Counted first so the answer says what's actually in the way. Lines of a bulk
	// transaction carry their parent's party, hence the count can exceed what the
	// table shows.
	const { count, error: countError } = await admin
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

	const { count: taskCount, error: taskCountError } = await admin
		.from('task_assignees')
		.select('id', { count: 'exact', head: true })
		.eq('ghost_member_id', ghostId);

	if (taskCountError) {
		return new Response(`Failed to delete ghost member: ${taskCountError.message}`, { status: 500 });
	}
	if ((taskCount ?? 0) > 0) {
		return new Response(
			'This ghost member is appointed to tasks — unappoint them first',
			{ status: 400 },
		);
	}

	const { data: removed, error } = await admin
		.from('ghost_members')
		.delete()
		.eq('id', ghostId)
		.eq('project_id', projectId)
		.select('id')
		.maybeSingle();

	if (error) {
		return new Response(`Failed to delete ghost member: ${error.message}`, { status: 500 });
	}
	if (!removed) {
		return new Response('Ghost member not found', { status: 404 });
	}

	return new Response(null, { status: 204 });
};
