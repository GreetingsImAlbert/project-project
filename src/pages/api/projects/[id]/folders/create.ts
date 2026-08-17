import type { APIRoute } from 'astro';
import { errorResponse } from '../../../../../lib/error-report';
import { journalSchemaClient } from '../../../../../lib/journal';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
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

	if (name.length > 200) {
		return new Response('Folder name: max 200 characters', { status: 400 });
	}

	if (parentFolderId) {
		const { data: parentFolder } = await journalSchemaClient(locals.supabase)
			.from('folders')
			.select('id, is_journals_folder')
			.eq('id', parentFolderId)
			.eq('project_id', projectId)
			.single();

		if (!parentFolder || parentFolder.is_journals_folder) {
			return new Response('Parent folder not found', { status: 400 });
		}
	}

	const { data: created, error } = await journalSchemaClient(locals.supabase)
		.from('folders')
		.insert({ project_id: projectId, name, parent_folder_id: parentFolderId })
		.select('id, name, parent_folder_id, is_journals_folder')
		.single();

	if (error) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to create folder: ${error.message}`,
			action: 'Failed to create folder.',
			context: { projectId: projectId ?? null },
		});
	}

	return Response.json(created);
};
