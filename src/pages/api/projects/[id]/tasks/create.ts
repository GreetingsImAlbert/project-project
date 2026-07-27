import type { APIRoute } from 'astro';
import { parseTaskForm } from '../../../../../lib/task-form';
import { TASK_COLUMNS, normalizeTask, type RawTaskRow } from '../../../../../lib/task-columns';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const projectId = params.id;

	// One read covers both checks: the caller's own role, and the set of ids that
	// may legally be appointed to the task.
	const { data: members } = await locals.supabase
		.from('project_members')
		.select('user_id, role')
		.eq('project_id', projectId);

	const membership = members?.find((m) => m.user_id === locals.user!.id);

	// Tasks follow base editor rights, not can_edit_money — they're general project
	// work, so a plain editor can manage them and a viewer cannot.
	if (!membership || !['owner', 'editor'].includes(membership.role)) {
		return new Response('Forbidden', { status: 403 });
	}

	const formData = await request.formData();
	const parsed = parseTaskForm(formData, new Set((members ?? []).map((m) => m.user_id)));

	if ('error' in parsed) {
		return new Response(parsed.error, { status: 400 });
	}

	const { name, category, description, deadline, status, assignees } = parsed.values;

	const { data: created, error } = await locals.supabase
		.from('tasks')
		.insert({ project_id: projectId!, name, category, description, deadline, status })
		.select('id')
		.single();

	if (error || !created) {
		return new Response(`Failed to create task: ${error?.message ?? 'unknown error'}`, { status: 500 });
	}

	if (assignees.length > 0) {
		const { error: assignError } = await locals.supabase
			.from('task_assignees')
			.insert(assignees.map((userId) => ({ task_id: created.id, user_id: userId })));

		// No transaction spans the two statements, so a failed appointment is
		// compensated the way confirm.ts compensates a failed files insert: undo the
		// half that landed rather than leave a task the user never asked for.
		if (assignError) {
			await locals.supabase.from('tasks').delete().eq('id', created.id);
			return new Response(`Failed to appoint members: ${assignError.message}`, { status: 500 });
		}
	}

	const { data: row, error: readError } = await locals.supabase
		.from('tasks')
		.select(TASK_COLUMNS)
		.eq('id', created.id)
		.single()
		.overrideTypes<RawTaskRow>();

	if (readError || !row) {
		return new Response('Task created but could not be read back', { status: 500 });
	}

	return Response.json(normalizeTask(row));
};
