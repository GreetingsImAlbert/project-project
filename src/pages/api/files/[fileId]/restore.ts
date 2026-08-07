import type { APIRoute } from 'astro';
import { errorResponse } from '../../../../lib/error-report';

export const prerender = false;

// Undoes delete.ts. If the file's folder is itself still trashed, it's reparented
// to the project root instead — restoring one item deep inside a trashed tree
// shouldn't leave it invisible under a still-deleted folder.
export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const fileId = params.fileId;

	const { data: file, error: fileError } = await locals.supabase
		.from('files')
		.select('project_id, folder_id, deleted_at')
		.eq('id', fileId)
		.single();

	if (fileError || !file) {
		return new Response('File not found', { status: 404 });
	}

	if (!file.deleted_at) {
		return new Response('File is not in the trash', { status: 400 });
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

	let folderId = file.folder_id;
	if (folderId) {
		const { data: folder } = await locals.supabase.from('folders').select('deleted_at').eq('id', folderId).maybeSingle();
		if (!folder || folder.deleted_at) folderId = null;
	}

	const { error } = await locals.supabase
		.from('files')
		.update({ deleted_at: null, folder_id: folderId })
		.eq('id', fileId);

	if (error) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to restore file: ${error.message}`,
			action: 'Failed to restore file.',
			context: { fileId: fileId ?? null, projectId: file.project_id },
		});
	}

	return new Response(null, { status: 204 });
};
