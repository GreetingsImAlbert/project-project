import type { APIRoute } from 'astro';
import { parseTaskForm } from '../../../../../lib/task-form';
import { TASK_COLUMNS, normalizeTask, type RawTaskRow } from '../../../../../lib/task-columns';
import { ghostIdOf } from '../../../../../lib/money-parties';
import { appToday } from '../../../../../lib/today';
import { errorResponse } from '../../../../../lib/error-report';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const projectId = params.id;

	// One read covers both checks: the caller's own role, and the set of ids that
	// may legally be appointed to the task. Ghost members are read alongside for the
	// same reason — a project's ghosts can be appointed too, same as a real member.
	const [{ data: members }, { data: ghosts }] = await Promise.all([
		locals.supabase.from('project_members').select('user_id, role').eq('project_id', projectId),
		locals.supabase.from('ghost_members').select('id').eq('project_id', projectId),
	]);

	const membership = members?.find((m) => m.user_id === locals.user!.id);

	// Tasks follow base editor rights, not can_edit_money — they're general project
	// work, so a plain editor can manage them and a viewer cannot.
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

	const { name, category, description, start_date, start_time, deadline, deadline_time, assignees } = parsed.values;
	const effectiveStartDate = start_date ?? appToday();

	const { data: createdId, error } = await locals.supabase.rpc('create_task_with_assignees', {
		p_project_id: projectId!,
		p_name: name,
		p_category: category,
		p_description: description,
		p_start_date: effectiveStartDate,
		p_start_time: start_time,
		p_deadline: deadline,
		p_deadline_time: deadline_time,
		p_status: 'ongoing',
		p_user_ids: assignees.filter((partyId) => !ghostIdOf(partyId)),
		p_ghost_member_ids: assignees.flatMap((partyId) => {
			const ghostId = ghostIdOf(partyId);
			return ghostId ? [ghostId] : [];
		}),
	});

	if (error || !createdId) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to create task: ${error?.message ?? 'unknown error'}`,
			action: 'Failed to create task.',
			context: { projectId: projectId ?? null },
		});
	}

	const { data: row, error: readError } = await locals.supabase
		.from('tasks')
		.select(TASK_COLUMNS)
		.eq('id', createdId)
		.single()
		.overrideTypes<RawTaskRow>();

	if (readError || !row) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Task created but could not be read back: ${readError?.message ?? 'unknown error'}`,
			action: 'Task created but could not be read back.',
			context: { projectId: projectId ?? null, taskId: createdId ?? null },
		});
	}

	return Response.json(normalizeTask(row));
};
