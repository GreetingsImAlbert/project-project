import type { APIRoute } from 'astro';
import { parseTaskForm } from '../../../../lib/task-form';
import { TASK_COLUMNS, normalizeTask, type RawTaskRow } from '../../../../lib/task-columns';
import { ghostIdOf } from '../../../../lib/money-parties';
import { errorResponse } from '../../../../lib/error-report';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const taskId = params.taskId;

	const { data: task, error: taskError } = await locals.supabase
		.from('tasks')
		.select('project_id')
		.eq('id', taskId)
		.single()
		.overrideTypes<{ project_id: string }>();

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

	const { name, category, description, start_date, start_time, deadline, deadline_time, status, assignees, keptDeletedAssigneeIds } = parsed.values;
	const { error } = await locals.supabase.rpc('update_task_with_assignees', {
		p_task_id: taskId!,
		p_name: name,
		p_category: category,
		p_description: description,
		p_start_date: start_date,
		p_start_time: start_time,
		p_deadline: deadline,
		p_deadline_time: deadline_time,
		p_status: status,
		p_user_ids: assignees.filter((partyId) => !ghostIdOf(partyId)),
		p_ghost_member_ids: assignees.flatMap((partyId) => {
			const ghostId = ghostIdOf(partyId);
			return ghostId ? [ghostId] : [];
		}),
		p_kept_deleted_assignee_ids: keptDeletedAssigneeIds,
	});

	if (error) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to update task: ${error.message}`,
			action: 'Failed to update task.',
			context: { taskId: taskId ?? null, projectId: task.project_id },
		});
	}

	const { data: row, error: readError } = await locals.supabase
		.from('tasks')
		.select(TASK_COLUMNS)
		.eq('id', taskId)
		.single()
		.overrideTypes<RawTaskRow>();

	if (readError || !row) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Task updated but could not be read back: ${readError?.message ?? 'unknown error'}`,
			action: 'Task updated but could not be read back.',
			context: { taskId: taskId ?? null, projectId: task.project_id },
		});
	}

	return Response.json(normalizeTask(row));
};
