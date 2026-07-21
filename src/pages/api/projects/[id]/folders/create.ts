import type { APIRoute } from 'astro';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals, redirect }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const projectId = params.id;

	const { data: membership } = await locals.supabase
		.from('project_members')
		.select('role')
		.eq('project_id', projectId)
		.eq('user_id', locals.user.id)
		.single();

	if (!membership || !['owner', 'editor'].includes(membership.role)) {
		return new Response('Forbidden', { status: 403 });
	}

	const formData = await request.formData();
	const name = formData.get('name')?.toString();
	const parentFolderId = formData.get('parentFolderId')?.toString() || null;

	if (!name) {
		return new Response('Folder name is required', { status: 400 });
	}

	const { error } = await locals.supabase
		.from('folders')
		.insert({ project_id: projectId, name, parent_folder_id: parentFolderId });

	if (error) {
		return new Response(`Failed to create folder: ${error.message}`, { status: 500 });
	}

	const redirectUrl = parentFolderId
		? `/projects/${projectId}?folder=${parentFolderId}`
		: `/projects/${projectId}`;

	return redirect(redirectUrl);
};
