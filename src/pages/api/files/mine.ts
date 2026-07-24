import type { APIRoute } from 'astro';

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const { data: files, error } = await locals.supabase
		.from('files')
		.select('id, filename, size_bytes, mime_type, created_at, project_id, projects(name)')
		.eq('uploaded_by', locals.user.id)
		.order('created_at', { ascending: false })
		.overrideTypes<{ id: string; filename: string; size_bytes: number | null; mime_type: string | null; created_at: string; project_id: string; projects: { name: string } }[]>();

	if (error) {
		return new Response(`Failed to load files: ${error.message}`, { status: 500 });
	}

	return Response.json(files ?? []);
};
