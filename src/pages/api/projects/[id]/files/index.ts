import type { APIRoute } from 'astro';
import { errorResponse } from '../../../../../lib/error-report';

export const prerender = false;

export const GET: APIRoute = async ({ params, url, request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const projectId = params.id;
	const folderId = url.searchParams.get('folderId');

	let query = locals.supabase
		.from('files')
		.select('id, filename, size_bytes, mime_type, created_at, uploaded_by, is_journal, is_public, profiles(display_name)')
		.eq('project_id', projectId)
		.order('created_at', { ascending: false });

	query = folderId ? query.eq('folder_id', folderId) : query.is('folder_id', null);

	const { data: files, error } = await query
		.overrideTypes<{ id: string; filename: string; size_bytes: number | null; mime_type: string | null; created_at: string; uploaded_by: string; is_journal: boolean; is_public: boolean; profiles: { display_name: string } }[]>();

	if (error) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to load files: ${error.message}`,
			action: 'Failed to load files.',
			context: { projectId: projectId ?? null },
		});
	}

	return Response.json(files ?? []);
};
