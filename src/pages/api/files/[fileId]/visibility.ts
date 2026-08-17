import type { APIRoute } from 'astro';
import { errorResponse } from '../../../../lib/error-report';

export const prerender = false;

// Owners and editors may opt a file into the project's public-files gate. The
// project gate itself remains owner-only; this endpoint only changes one file.
export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const fileId = params.fileId;

	const { data: file, error: fileError } = await locals.supabase
		.from('files')
		.select('project_id, is_journal')
		.eq('id', fileId)
		.single();

	if (fileError || !file) {
		return new Response('File not found', { status: 404 });
	}

	if (file.is_journal) {
		return new Response('Journal files cannot be public', { status: 403 });
	}

	const { data: membership } = await locals.supabase
		.from('project_members')
		.select('role')
		.eq('project_id', file.project_id)
		.eq('user_id', locals.user.id)
		.single();

	if (!membership || !['owner', 'editor'].includes(membership.role)) {
		return new Response('Forbidden', { status: 403 });
	}

	let isPublic: unknown;
	try {
		isPublic = (await request.json() as { isPublic?: unknown }).isPublic;
	} catch {
		return new Response('Invalid request body', { status: 400 });
	}

	if (typeof isPublic !== 'boolean') {
		return new Response('Invalid visibility value', { status: 400 });
	}

	const { error } = await locals.supabase
		.from('files')
		.update({ is_public: isPublic })
		.eq('id', fileId);

	if (error) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to update file visibility: ${error.message}`,
			action: 'Failed to update file visibility.',
			context: { fileId: fileId ?? null, projectId: file.project_id },
		});
	}

	return Response.json({ isPublic });
};
