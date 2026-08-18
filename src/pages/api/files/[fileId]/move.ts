import type { APIRoute } from 'astro';
import { errorResponse } from '../../../../lib/error-report';
import { journalSchemaClient } from '../../../../lib/journal';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const fileId = params.fileId;

	const { data: file, error: fileError } = await journalSchemaClient(locals.supabase)
		.from('files')
		.select('project_id, is_journal')
		.eq('id', fileId)
		.single();

	if (fileError || !file) {
		return new Response('File not found', { status: 404 });
	}
	if (file.is_journal) {
		return new Response('Journal files cannot be moved', { status: 403 });
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

	const body = await request.json() as { folderId?: string | null };
	const targetFolderId = body.folderId || null;

	if (targetFolderId) {
		const { data: targetFolder } = await journalSchemaClient(locals.supabase)
			.from('folders')
			.select('id, is_journals_folder')
			.eq('id', targetFolderId)
			.eq('project_id', file.project_id)
			.single();

		if (!targetFolder || targetFolder.is_journals_folder) {
			return new Response('Target folder not found', { status: 400 });
		}
	}

	const { error } = await locals.supabase
		.from('files')
		.update({ folder_id: targetFolderId })
		.eq('id', fileId);

	if (error) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to move file: ${error.message}`,
			action: 'Failed to move file.',
			context: { fileId: fileId ?? null, projectId: file.project_id },
		});
	}

	return new Response(null, { status: 204 });
};
