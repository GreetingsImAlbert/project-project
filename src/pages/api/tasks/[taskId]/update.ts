import type { APIRoute } from 'astro';
import { parseTaskForm, taskAssigneeColumns } from '../../../../lib/task-form';
import { TASK_COLUMNS, normalizeTask, type RawTaskRow } from '../../../../lib/task-columns';
import { ghostIdOf, ghostPartyId, isGhostParty } from '../../../../lib/money-parties';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const taskId = params.taskId;

	const { data: task, error: taskError } = await locals.supabase
		.from('tasks')
		.select('project_id, task_assignees(id, user_id, ghost_member_id)')
		.eq('id', taskId)
		.single()
		.overrideTypes<{
			project_id: string;
			task_assignees: { id: string; user_id: string | null; ghost_member_id: string | null }[];
		}>();

	if (taskError || !task) {
		return new Response('Task not found', { status: 404 });
	}

	const [{ data: members }, { data: ghosts }] = await Promise.all([
		locals.supabase.from('project_members').select('user_id, role').eq('project_id', task.project_id),
		locals.supabase.from('ghost_members').select('id').eq('project_id', task.project_id),
	]);

	const membership = members?.find((m) => m.user_id === locals.user!.id);

	if (!membership || !['owner', 'editor'].includes(membership.role)) {
		return new Response('Forbidden', { status: 403 });
	}

	const formData = await request.formData();
	const parsed = parseTaskForm(
		formData,
		new Set((members ?? []).map((m) => m.user_id)),
		new Set((ghosts ?? []).map((g) => g.id)),
	);

	if ('error' in parsed) {
		return new Response(parsed.error, { status: 400 });
	}

	const { name, category, description, start_date, deadline, deadline_time, status, assignees, keptDeletedAssigneeIds } = parsed.values;

	const { error } = await locals.supabase
		.from('tasks')
		.update({ name, category, description, start_date, deadline, deadline_time, status })
		.eq('id', taskId!);

	if (error) {
		return new Response(`Failed to update task: ${error.message}`, { status: 500 });
	}

	// Diffed rather than deleted-and-reinserted wholesale: an unchanged appointment
	// stays put, and a submit that doesn't touch the members can't drop them on the
	// floor if the re-insert half fails. It also means task_assignees needs no UPDATE
	// policy — every write here is an insert or a delete.
	//
	// A deleted account's row has no user_id or ghost_member_id to diff by (see
	// task-columns.ts), so those are diffed separately by the row's own id against
	// keptDeletedAssigneeIds — parseTaskForm already split the submitted tokens into
	// the two spaces. Live rows are diffed by party token — a bare user id or a
	// `ghost:<id>` — so a member and a ghost can be added/removed in the same pass.
	const currentPartyTokens = new Set(
		(task.task_assignees ?? []).flatMap((a) => {
			if (a.user_id) return [a.user_id];
			if (a.ghost_member_id) return [ghostPartyId(a.ghost_member_id)];
			return [];
		}),
	);
	const currentDeletedRowIds = new Set(
		(task.task_assignees ?? []).flatMap((a) => (a.user_id || a.ghost_member_id ? [] : [a.id])),
	);

	const nextPartyTokens = new Set(assignees);
	const keptDeletedRowIds = new Set(keptDeletedAssigneeIds);

	const removedPartyTokens = [...currentPartyTokens].filter((t) => !nextPartyTokens.has(t));
	const addedPartyTokens = [...nextPartyTokens].filter((t) => !currentPartyTokens.has(t));
	const removedDeletedRowIds = [...currentDeletedRowIds].filter((id) => !keptDeletedRowIds.has(id));

	const removedMemberIds = removedPartyTokens.filter((t) => !isGhostParty(t));
	const removedGhostIds = removedPartyTokens.filter(isGhostParty).map((t) => ghostIdOf(t)!);

	if (removedMemberIds.length > 0) {
		const { error: removeError } = await locals.supabase
			.from('task_assignees')
			.delete()
			.eq('task_id', taskId!)
			.in('user_id', removedMemberIds);

		if (removeError) {
			return new Response(`Failed to update appointed members: ${removeError.message}`, { status: 500 });
		}
	}

	if (removedGhostIds.length > 0) {
		const { error: removeGhostError } = await locals.supabase
			.from('task_assignees')
			.delete()
			.eq('task_id', taskId!)
			.in('ghost_member_id', removedGhostIds);

		if (removeGhostError) {
			return new Response(`Failed to update appointed members: ${removeGhostError.message}`, { status: 500 });
		}
	}

	if (removedDeletedRowIds.length > 0) {
		const { error: removeDeletedError } = await locals.supabase
			.from('task_assignees')
			.delete()
			.eq('task_id', taskId!)
			.in('id', removedDeletedRowIds);

		if (removeDeletedError) {
			return new Response(`Failed to update appointed members: ${removeDeletedError.message}`, { status: 500 });
		}
	}

	if (addedPartyTokens.length > 0) {
		const { error: addError } = await locals.supabase
			.from('task_assignees')
			.insert(addedPartyTokens.map((partyId) => ({ task_id: taskId!, ...taskAssigneeColumns(partyId) })));

		if (addError) {
			return new Response(`Failed to update appointed members: ${addError.message}`, { status: 500 });
		}
	}

	const { data: row, error: readError } = await locals.supabase
		.from('tasks')
		.select(TASK_COLUMNS)
		.eq('id', taskId)
		.single()
		.overrideTypes<RawTaskRow>();

	if (readError || !row) {
		return new Response('Task updated but could not be read back', { status: 500 });
	}

	return Response.json(normalizeTask(row));
};
