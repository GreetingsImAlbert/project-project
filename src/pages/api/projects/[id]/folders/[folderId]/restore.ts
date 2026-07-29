import type { APIRoute } from 'astro';

export const prerender = false;

// Undoes delete.ts for a single folder. If its parent is itself still trashed,
// it's reparented to the project root instead — restoring one folder deep inside
// a trashed tree shouldn't leave it invisible under a still-deleted ancestor.
// Restoring a whole subtree back together means restoring each folder in it, from
// the bottom up (a parent up first would briefly leave a child pointing nowhere
// visible, which is harmless but reads oddly), or its own root down — the Trash
// page lists every trashed folder individually either way.
export const POST: APIRoute = async ({ params, locals }) => {
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

	const { data: folder, error: folderError } = await locals.supabase
		.from('folders')
		.select('id, parent_folder_id, deleted_at')
		.eq('id', folderId)
		.eq('project_id', projectId)
		.single();

	if (folderError || !folder) {
		return new Response('Folder not found', { status: 404 });
	}

	if (!folder.deleted_at) {
		return new Response('Folder is not in the trash', { status: 400 });
	}

	let parentFolderId = folder.parent_folder_id;
	if (parentFolderId) {
		const { data: parent } = await locals.supabase
			.from('folders')
			.select('deleted_at')
			.eq('id', parentFolderId)
			.maybeSingle();
		if (!parent || parent.deleted_at) parentFolderId = null;
	}

	const { error } = await locals.supabase
		.from('folders')
		.update({ deleted_at: null, parent_folder_id: parentFolderId })
		.eq('id', folderId);

	if (error) {
		return new Response(`Failed to restore folder: ${error.message}`, { status: 500 });
	}

	return new Response(null, { status: 204 });
};
