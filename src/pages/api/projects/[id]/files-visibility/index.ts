import type { APIRoute } from 'astro';

export const prerender = false;

// Owner-only project gate for public files. The per-file flag is a separate
// opt-in, so changing this gate never changes individual file settings.
export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const projectId = params.id;

	const { data: project, error } = await locals.supabase
		.from('projects')
		.select('owner_id')
		.eq('id', projectId)
		.maybeSingle();

	if (error) return new Response(`Failed to read project: ${error.message}`, { status: 500 });
	if (!project) return new Response('Project not found', { status: 404 });
	if (project.owner_id !== locals.user.id) return new Response('Forbidden', { status: 403 });

	let publicFilesEnabled: unknown;
	try {
		publicFilesEnabled = (await request.json() as { publicFilesEnabled?: unknown }).publicFilesEnabled;
	} catch {
		return new Response('Invalid request body', { status: 400 });
	}

	if (typeof publicFilesEnabled !== 'boolean') {
		return new Response('Invalid files visibility value', { status: 400 });
	}

	const { error: updateError } = await locals.supabase
		.from('projects')
		.update({ public_files_enabled: publicFilesEnabled })
		.eq('id', projectId);

	if (updateError) return new Response(`Failed to update files visibility: ${updateError.message}`, { status: 500 });

	return Response.json({ publicFilesEnabled });
};
