import type { APIRoute } from 'astro';
import { errorResponse } from '../../../../../lib/error-report';
import {
	parsePublicVisibilityRequest,
	PUBLIC_SECTION_COLUMNS,
} from '../../../../../lib/project-visibility';

export const prerender = false;

// The one setting that decides whether a logged-out visitor can see the project.
// Owner-only, matching the update RLS policy (owner_id = auth.uid()). A viewer
// member is 403; an authenticated non-member can't even see the row through RLS,
// so they land on the same 404 a missing project does — no existence leak.
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

	if (error) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to read project: ${error.message}`,
			action: 'Failed to read project.',
			context: { projectId: projectId ?? null },
		});
	}
	if (!project) return new Response('Project not found', { status: 404 });
	if (project.owner_id !== locals.user.id) return new Response('Forbidden', { status: 403 });

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return new Response('Invalid request body', { status: 400 });
	}

	const parsed = parsePublicVisibilityRequest(body);
	if (!parsed) {
		return new Response('Invalid visibility section or value', { status: 400 });
	}
	const { section, enabled } = parsed;

	const column = PUBLIC_SECTION_COLUMNS[section];
	const { error: updateError } = await locals.supabase
		.from('projects')
		// The column comes only from the static section allowlist. The generated
		// database types are refreshed separately after the migration is applied.
		.update({ [column]: enabled } as never)
		.eq('id', projectId);

	if (updateError) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to update ${section} visibility: ${updateError.message}`,
			action: 'Failed to update visibility.',
			context: { projectId: projectId ?? null },
		});
	}

	return Response.json({ section, enabled });
};
