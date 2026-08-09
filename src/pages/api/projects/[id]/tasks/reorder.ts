import type { APIRoute } from 'astro';
import { errorResponse } from '../../../../../lib/error-report';
import {
	expectedRpcErrorResponse,
	isUuid,
	parseTaskReorderPayload,
	readCanonicalTaskOrders,
	readJsonObject,
} from '../../../../../lib/task-reorder';
import { canEditTasks } from '../../../../../lib/task-permissions';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) return new Response('Unauthorized', { status: 401 });

	const projectId = params.id;
	if (!isUuid(projectId)) return new Response('Invalid project ID', { status: 400 });

	const { data: membership, error: membershipError } = await locals.supabase
		.from('project_members')
		.select('role')
		.eq('project_id', projectId)
		.eq('user_id', locals.user.id)
		.maybeSingle();
	if (membershipError) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to check task reorder permission: ${membershipError.message}`,
			action: 'Failed to reorder tasks.',
			context: { projectId },
		});
	}
	if (!membership || !canEditTasks(membership.role)) return new Response('Forbidden', { status: 403 });

	const body = await readJsonObject(request);
	if ('error' in body) return new Response(body.error, { status: 400 });
	const parsed = parseTaskReorderPayload(body.value);
	if ('error' in parsed) return new Response(parsed.error, { status: 400 });

	const payload = parsed.value;
	const rpcResult =
		payload.type === 'category'
			? await locals.supabase.rpc('reorder_tasks_in_category', {
					p_project_id: projectId,
					p_category_name: payload.category ?? '',
					p_task_ids: payload.taskIds,
				})
			: await locals.supabase.rpc('move_task_to_category', {
					p_project_id: projectId,
					p_task_id: payload.taskId,
					p_source_category: payload.sourceCategory ?? '',
					p_destination_category: payload.destinationCategory ?? '',
					p_source_task_ids: payload.sourceTaskIds,
					p_destination_task_ids: payload.destinationTaskIds,
				});

	if (rpcResult.error) {
		const expected = expectedRpcErrorResponse(rpcResult.error.message);
		if (expected) return new Response(expected.message, { status: expected.status });
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to persist task reorder: ${rpcResult.error.message}`,
			action: 'Failed to reorder tasks.',
			context: {
				projectId,
				type: payload.type,
				...(payload.type === 'category'
					? { category: payload.category, taskCount: payload.taskIds.length }
					: { taskId: payload.taskId, sourceCount: payload.sourceTaskIds.length, destinationCount: payload.destinationTaskIds.length }),
			},
		});
	}

	const categories =
		payload.type === 'category' ? [payload.category] : [payload.sourceCategory, payload.destinationCategory];
	const canonical = await readCanonicalTaskOrders(locals.supabase, projectId, categories);
	if (canonical.error) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Task reorder persisted but could not be read back: ${canonical.error.message}`,
			action: 'Tasks reordered but could not be read back.',
			context: { projectId, type: payload.type },
		});
	}

	return Response.json({
		ok: true,
		type: payload.type,
		...(payload.type === 'move' ? { taskId: payload.taskId } : {}),
		orders: canonical.data,
	});
};
