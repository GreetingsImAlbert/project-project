import type { APIRoute } from 'astro';

export const prerender = false;

export const POST: APIRoute = async ({ params, locals, redirect }) => {
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
		.select('parent_folder_id')
		.eq('id', folderId)
		.eq('project_id', projectId)
		.single();

	if (folderError || !folder) {
		return new Response('Folder not found', { status: 404 });
	}

	const { count: subfolderCount } = await locals.supabase
		.from('folders')
		.select('id', { count: 'exact', head: true })
		.eq('parent_folder_id', folderId);

	const { count: fileCount } = await locals.supabase
		.from('files')
		.select('id', { count: 'exact', head: true })
		.eq('folder_id', folderId);

	if ((subfolderCount ?? 0) > 0 || (fileCount ?? 0) > 0) {
		return new Response('Folder is not empty', { status: 400 });
	}

	const { error } = await locals.supabase.from('folders').delete().eq('id', folderId);

	if (error) {
		return new Response(`Failed to delete folder: ${error.message}`, { status: 500 });
	}

	const redirectUrl = folder.parent_folder_id
		? `/projects/${projectId}?folder=${folder.parent_folder_id}`
		: `/projects/${projectId}`;

	return redirect(redirectUrl);
};
