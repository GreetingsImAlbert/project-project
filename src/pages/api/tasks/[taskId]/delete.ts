import type { APIRoute } from 'astro';
import { errorResponse } from '../../../../lib/error-report';

export const prerender = false;

// Soft-delete — moves the task to the project's Trash instead of removing it.
export const POST: APIRoute = async ({ params, request, locals }) => {
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

	// task_assignees is left untouched — a soft-delete never fires the cascade, so a
	// restored task keeps its appointments. The cron purge is what eventually cascades.
	const { error } = await locals.supabase.from('tasks').update({ deleted_at: new Date().toISOString() }).eq('id', taskId!);

	if (error) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to delete task: ${error.message}`,
			action: 'Failed to delete task.',
			context: { taskId: taskId ?? null, projectId: task.project_id },
		});
	}

	return new Response(null, { status: 204 });
};
