import type { APIRoute } from 'astro';
import { errorResponse } from '../../../../../../lib/error-report';
import { collectDescendantFolderIds } from '../../../../../../lib/folder-tree';
import { journalSchemaClient } from '../../../../../../lib/journal';

export const prerender = false;

// Soft-delete — stamps deleted_at on the whole folder subtree and every file under
// it in one pass, moving them to the project's Trash instead of removing them.
// The R2 objects and rows themselves are left alone until the trash cron (or a
// user-triggered permanent delete, see purge.ts) actually removes them.
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
		.select('id, is_journals_folder')
		.eq('id', folderId)
		.eq('project_id', projectId)
		.single();

	if (folderError || !folder) {
		return new Response('Folder not found', { status: 404 });
	}
	if (folder.is_journals_folder) return new Response('The journals folder cannot be deleted', { status: 403 });

	const folderIds = await collectDescendantFolderIds(locals.supabase, folderId!);
	const [{ data: protectedFolders }, { data: journalFiles }] = await Promise.all([
		journalSchemaClient(locals.supabase).from('folders').select('id').in('id', folderIds).eq('is_journals_folder', true),
		journalSchemaClient(locals.supabase).from('files').select('id').in('folder_id', folderIds).eq('is_journal', true),
	]);
	if ((protectedFolders?.length ?? 0) > 0 || (journalFiles?.length ?? 0) > 0) {
		return new Response('Folders containing journals cannot be deleted', { status: 403 });
	}

	const deletedAt = new Date().toISOString();

	const { error } = await locals.supabase.rpc('soft_delete_folder_tree', {
		p_project_id: projectId!,
		p_folder_id: folderId!,
		p_deleted_at: deletedAt,
	});

	if (error) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to delete folder contents: ${error.message}`,
			action: 'Failed to delete folder contents.',
			context: { projectId: projectId ?? null, folderId: folderId ?? null },
		});
	}

	return new Response(null, { status: 204 });
};
