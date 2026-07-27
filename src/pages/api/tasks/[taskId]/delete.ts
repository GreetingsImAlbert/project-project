import type { APIRoute } from 'astro';

export const prerender = false;

export const POST: APIRoute = async ({ params, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const taskId = params.taskId;

	const { data: task, error: taskError } = await locals.supabase
		.from('tasks')
		.select('project_id')
		.eq('id', taskId)
		.single();

	if (taskError || !task) {
		return new Response('Task not found', { status: 404 });
	}

	const { data: membership } = await locals.supabase
		.from('project_members')
		.select('role')
		.eq('project_id', task.project_id)
		.eq('user_id', locals.user.id)
		.single();

	if (!membership || !['owner', 'editor'].includes(membership.role)) {
		return new Response('Forbidden', { status: 403 });
	}

	// task_assignees cascades on the FK, so the appointments go with the task.
	const { error } = await locals.supabase.from('tasks').delete().eq('id', taskId!);

	if (error) {
		return new Response(`Failed to delete task: ${error.message}`, { status: 500 });
	}

	return new Response(null, { status: 204 });
};
