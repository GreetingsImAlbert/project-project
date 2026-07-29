import type { APIRoute } from 'astro';

export const prerender = false;

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

	const { data: folder, error: folderError } = await locals.supabase
		.from('folders')
		.select('id')
		.eq('id', folderId)
		.eq('project_id', projectId)
		.single();

	if (folderError || !folder) {
		return new Response('Folder not found', { status: 404 });
	}

	const body = await request.json() as { name?: string };
	const name = body.name?.trim();

	if (!name) {
		return new Response('Folder name is required', { status: 400 });
	}

	if (name.length > 200) {
		return new Response('Folder name: max 200 characters', { status: 400 });
	}

	const { error } = await locals.supabase
		.from('folders')
		.update({ name })
		.eq('id', folderId);

	if (error) {
		return new Response(`Failed to rename folder: ${error.message}`, { status: 500 });
	}

	return new Response(null, { status: 204 });
};
