import type { APIRoute } from 'astro';
import { errorResponse } from '../../../lib/error-report';
import { journalSchemaClient } from '../../../lib/journal';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const { data: files, error } = await journalSchemaClient(locals.supabase)
		.from('files')
		.select('id, filename, size_bytes, mime_type, created_at, project_id, is_journal, journal_kind, projects(name)')
		.eq('uploaded_by', locals.user.id)
		.is('deleted_at', null)
		// The modal groups by project and shows the biggest file first; a `desc` order in
		// Postgres puts nulls first, which would float a file with no recorded size to the
		// top of its group. `created_at` only breaks ties between equal sizes.
		.order('size_bytes', { ascending: false, nullsFirst: false })
		.order('created_at', { ascending: false });

	if (error) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to load files: ${error.message}`,
			action: 'Failed to load files.',
		});
	}

	const projectIds = [...new Set((files ?? []).map((file: any) => file.project_id))];
	const { data: memberships } = projectIds.length > 0
		? await locals.supabase.from('project_members').select('project_id, role').eq('user_id', locals.user.id).in('project_id', projectIds)
		: { data: [] };
	const roleByProject = new Map((memberships ?? []).map((membership) => [membership.project_id, membership.role]));
	return Response.json((files ?? []).map((file: any) => ({
		id: file.id,
		filename: file.filename,
		size_bytes: file.size_bytes,
		mime_type: file.mime_type,
		created_at: file.created_at,
		project_id: file.project_id,
		projects: file.projects,
		canDelete: file.is_journal
			? file.journal_kind === 'personal'
			: ['owner', 'editor'].includes(roleByProject.get(file.project_id) ?? ''),
	})));
};
