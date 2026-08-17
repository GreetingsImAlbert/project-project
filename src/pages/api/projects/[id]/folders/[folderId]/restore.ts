import type { APIRoute } from 'astro';
import { errorResponse } from '../../../../../../lib/error-report';
import { journalSchemaClient } from '../../../../../../lib/journal';

export const prerender = false;

// Undoes delete.ts for a single folder. If its parent is itself still trashed,
// it's reparented to the project root instead — restoring one folder deep inside
// a trashed tree shouldn't leave it invisible under a still-deleted ancestor.
// Restoring a whole subtree back together means restoring each folder in it, from
// the bottom up (a parent up first would briefly leave a child pointing nowhere
// visible, which is harmless but reads oddly), or its own root down — the Trash
// page lists every trashed folder individually either way.
export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const projectId = params.id;
	const folderId = params.folderId;

	const { data: membership } = await locals.supabase
		.from('project_members')
		.select('role')
		.eq('project_id', projectId)
		.eq('user_id', locals.user.id)
		.single();

	if (!membership || !['owner', 'editor'].includes(membership.role)) {
		return new Response('Forbidden', { status: 403 });
	}

	const { data: folder, error: folderError } = await journalSchemaClient(locals.supabase)
		.from('folders')
		.select('id, parent_folder_id, deleted_at, is_journals_folder')
		.eq('id', folderId)
		.eq('project_id', projectId)
		.single();

	if (folderError || !folder) {
		return new Response('Folder not found', { status: 404 });
	}
	if (folder.is_journals_folder) return new Response('The journals folder cannot be restored from Trash', { status: 403 });

	if (!folder.deleted_at) {
		return new Response('Folder is not in the trash', { status: 400 });
	}

	let parentFolderId = folder.parent_folder_id;
	if (parentFolderId) {
		const { data: parent } = await journalSchemaClient(locals.supabase)
			.from('folders')
			.select('deleted_at, is_journals_folder')
			.eq('id', parentFolderId)
			.maybeSingle();
		if (!parent || parent.deleted_at || parent.is_journals_folder) parentFolderId = null;
	}

	const { error } = await locals.supabase
		.from('folders')
		.update({ deleted_at: null, parent_folder_id: parentFolderId })
		.eq('id', folderId);

	if (error) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to restore folder: ${error.message}`,
			action: 'Failed to restore folder.',
			context: { projectId: projectId ?? null, folderId: folderId ?? null },
		});
	}

	return new Response(null, { status: 204 });
};
