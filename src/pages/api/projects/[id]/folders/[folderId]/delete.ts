import type { APIRoute } from 'astro';

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

	const deletedAt = new Date().toISOString();

	const { error } = await locals.supabase.rpc('soft_delete_folder_tree', {
		p_project_id: projectId!,
		p_folder_id: folderId!,
		p_deleted_at: deletedAt,
	});

	if (error) {
		return new Response(`Failed to delete folder contents: ${error.message}`, { status: 500 });
	}

	return new Response(null, { status: 204 });
};
