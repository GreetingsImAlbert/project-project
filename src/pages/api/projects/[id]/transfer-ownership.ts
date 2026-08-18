import type { APIRoute } from 'astro';
import { errorResponse } from '../../../../lib/error-report';
import { ownershipTransferStatus, parseOwnershipTransfer } from '../../../../lib/project-ownership';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) return new Response('Unauthorized', { status: 401 });

	const projectId = params.id;
	if (!projectId) return new Response('Project not found', { status: 404 });

	const parsed = parseOwnershipTransfer(await request.formData(), locals.user.id);
	if ('error' in parsed) return new Response(parsed.error, { status: 400 });

	const { error } = await locals.supabase.rpc('transfer_project_ownership', {
		p_project_id: projectId,
		p_new_owner_id: parsed.newOwnerId,
	});

	if (error) {
		const expectedStatus = ownershipTransferStatus(error.message);
		if (expectedStatus) return new Response(error.message, { status: expectedStatus });

		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to transfer project ownership: ${error.message}`,
			action: 'Failed to transfer ownership.',
			context: { projectId, newOwnerId: parsed.newOwnerId },
		});
	}

	return new Response(null, { status: 204 });
};
