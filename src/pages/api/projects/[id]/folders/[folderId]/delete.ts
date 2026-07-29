import type { APIRoute } from 'astro';
import { collectDescendantFolderIds } from '../../../../../../lib/folder-tree';

export const prerender = false;

// Soft-delete — stamps deleted_at on the whole folder subtree and every file under
// it in one pass, moving them to the project's Trash instead of removing them.
// The R2 objects and rows themselves are left alone until the trash cron (or a
// user-triggered permanent delete, see purge.ts) actually removes them.
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
		.select('id')
		.eq('id', folderId)
		.eq('project_id', projectId)
		.single();

	if (folderError || !folder) {
		return new Response('Folder not found', { status: 404 });
	}

	const folderIds = await collectDescendantFolderIds(locals.supabase, folderId as string);
	const deletedAt = new Date().toISOString();

	// Files under it first: not that order matters for correctness, just so a
	// failure here reports itself before the folder rows are touched.
	const { error: filesError } = await locals.supabase
		.from('files')
		.update({ deleted_at: deletedAt })
		.in('folder_id', folderIds)
		.is('deleted_at', null);

	if (filesError) {
		return new Response(`Failed to delete folder contents: ${filesError.message}`, { status: 500 });
	}

	const { error } = await locals.supabase
		.from('folders')
		.update({ deleted_at: deletedAt })
		.in('id', folderIds)
		.is('deleted_at', null);

	if (error) {
		return new Response(`Failed to delete folder: ${error.message}`, { status: 500 });
	}

	return new Response(null, { status: 204 });
};
