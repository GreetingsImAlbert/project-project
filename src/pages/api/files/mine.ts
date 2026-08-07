import type { APIRoute } from 'astro';
import { errorResponse } from '../../../lib/error-report';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const { data: files, error } = await locals.supabase
		.from('files')
		.select('id, filename, size_bytes, mime_type, created_at, project_id, projects(name)')
		.eq('uploaded_by', locals.user.id)
		.is('deleted_at', null)
		// The modal groups by project and shows the biggest file first; a `desc` order in
		// Postgres puts nulls first, which would float a file with no recorded size to the
		// top of its group. `created_at` only breaks ties between equal sizes.
		.order('size_bytes', { ascending: false, nullsFirst: false })
		.order('created_at', { ascending: false })
		.overrideTypes<{ id: string; filename: string; size_bytes: number | null; mime_type: string | null; created_at: string; project_id: string; projects: { name: string } }[]>();

	if (error) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to load files: ${error.message}`,
			action: 'Failed to load files.',
		});
	}

	return Response.json(files ?? []);
};
