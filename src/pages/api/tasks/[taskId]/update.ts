import type { APIRoute } from 'astro';
import { parseTaskForm } from '../../../../lib/task-form';
import { TASK_COLUMNS, normalizeTask, type RawTaskRow } from '../../../../lib/task-columns';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const taskId = params.taskId;

	const { data: task, error: taskError } = await locals.supabase
		.from('tasks')
		.select('project_id, task_assignees(user_id)')
		.eq('id', taskId)
		.single()
		.overrideTypes<{ project_id: string; task_assignees: { user_id: string }[] }>();

	if (taskError || !task) {
		return new Response('Task not found', { status: 404 });
	}

	const { data: members } = await locals.supabase
		.from('project_members')
		.select('user_id, role')
		.eq('project_id', task.project_id);

	const membership = members?.find((m) => m.user_id === locals.user!.id);

	if (!membership || !['owner', 'editor'].includes(membership.role)) {
		return new Response('Forbidden', { status: 403 });
	}

	const formData = await request.formData();
	const parsed = parseTaskForm(formData, new Set((members ?? []).map((m) => m.user_id)));

	if ('error' in parsed) {
		return new Response(parsed.error, { status: 400 });
	}

	const { name, category, description, deadline, status, assignees } = parsed.values;

	const { error } = await locals.supabase
		.from('tasks')
		.update({ name, category, description, deadline, status })
		.eq('id', taskId!);

	if (error) {
		return new Response(`Failed to update task: ${error.message}`, { status: 500 });
	}

	// Diffed rather than deleted-and-reinserted wholesale: an unchanged appointment
	// stays put, and a submit that doesn't touch the members can't drop them on the
	// floor if the re-insert half fails. It also means task_assignees needs no UPDATE
	// policy — every write here is an insert or a delete.
	const current = new Set((task.task_assignees ?? []).map((a) => a.user_id));
	const next = new Set(assignees);
	const removed = [...current].filter((id) => !next.has(id));
	const added = [...next].filter((id) => !current.has(id));

	if (removed.length > 0) {
		const { error: removeError } = await locals.supabase
			.from('task_assignees')
			.delete()
			.eq('task_id', taskId!)
			.in('user_id', removed);

		if (removeError) {
			return new Response(`Failed to update appointed members: ${removeError.message}`, { status: 500 });
		}
	}

	if (added.length > 0) {
		const { error: addError } = await locals.supabase
			.from('task_assignees')
			.insert(added.map((userId) => ({ task_id: taskId!, user_id: userId })));

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
