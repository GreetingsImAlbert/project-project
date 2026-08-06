import type { APIRoute } from 'astro';

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

	if (error) return new Response(`Failed to read project: ${error.message}`, { status: 500 });
	if (!project) return new Response('Project not found', { status: 404 });
	if (project.owner_id !== locals.user.id) return new Response('Forbidden', { status: 403 });

	let isPublic: unknown;
	try {
		isPublic = (await request.json() as { isPublic?: unknown }).isPublic;
	} catch {
		return new Response('Invalid request body', { status: 400 });
	}

	if (typeof isPublic !== 'boolean') {
		return new Response('Invalid visibility value', { status: 400 });
	}

	const { error: updateError } = await locals.supabase
		.from('projects')
		.update({ is_public: isPublic })
		.eq('id', projectId);

	if (updateError) return new Response(`Failed to update visibility: ${updateError.message}`, { status: 500 });

	return Response.json({ isPublic });
};
