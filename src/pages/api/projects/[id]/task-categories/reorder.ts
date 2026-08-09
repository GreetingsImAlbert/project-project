import type { APIRoute } from 'astro';
import { errorResponse } from '../../../../../lib/error-report';
import {
	expectedRpcErrorResponse,
	isUuid,
	parseCategoryReorderPayload,
	readCanonicalCategoryOrder,
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
			privateMessage: `Failed to check category reorder permission: ${membershipError.message}`,
			action: 'Failed to reorder task categories.',
			context: { projectId },
		});
	}
	if (!membership || !canEditTasks(membership.role)) return new Response('Forbidden', { status: 403 });

	const body = await readJsonObject(request);
	if ('error' in body) return new Response(body.error, { status: 400 });
	const parsed = parseCategoryReorderPayload(body.value);
	if ('error' in parsed) return new Response(parsed.error, { status: 400 });

	const { categoryNames } = parsed.value;
	const { error: rpcError } = await locals.supabase.rpc('reorder_task_categories', {
		p_project_id: projectId,
		// SQL normalizes empty text to NULL so the generated RPC type can stay text[].
		p_category_names: categoryNames.map((category) => category ?? ''),
	});

	if (rpcError) {
		const expected = expectedRpcErrorResponse(rpcError.message);
		if (expected) return new Response(expected.message, { status: expected.status });
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to persist category reorder: ${rpcError.message}`,
			action: 'Failed to reorder task categories.',
			context: { projectId, categoryCount: categoryNames.length },
		});
	}

	const canonical = await readCanonicalCategoryOrder(locals.supabase, projectId);
	if (canonical.error) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Category reorder persisted but could not be read back: ${canonical.error.message}`,
			action: 'Task categories reordered but could not be read back.',
			context: { projectId },
		});
	}

	return Response.json({ ok: true, ...canonical.data });
};
