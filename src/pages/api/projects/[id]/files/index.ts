import type { APIRoute } from 'astro';

export const prerender = false;

export const GET: APIRoute = async ({ params, url, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const projectId = params.id;
	const folderId = url.searchParams.get('folderId');

	let query = locals.supabase
		.from('files')
		.select('id, filename, size_bytes, mime_type, created_at, uploaded_by, profiles(display_name)')
		.eq('project_id', projectId)
		.order('created_at', { ascending: false });

	query = folderId ? query.eq('folder_id', folderId) : query.is('folder_id', null);

	const { data: files, error } = await query
		.overrideTypes<{ id: string; filename: string; size_bytes: number | null; mime_type: string | null; created_at: string; uploaded_by: string; profiles: { display_name: string } }[]>();

	if (error) {
		return new Response(`Failed to load files: ${error.message}`, { status: 500 });
	}

	return Response.json(files ?? []);
};