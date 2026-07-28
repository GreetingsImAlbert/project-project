import type { APIRoute } from 'astro';
import { canEditMoney } from '../../../../../lib/money-access';
import {
	GHOST_COLUMNS,
	MAX_GHOSTS_PER_PROJECT,
	ghostNameError,
	ghostNoteError,
	type GhostMemberRow,
} from '../../../../../lib/ghost-members';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const projectId = params.id;

	// A ghost member is a Money-page concept, so it follows money-edit rights (owner
	// or auditor) rather than general editor rights.
	if (!(await canEditMoney(locals.supabase, projectId!, locals.user.id))) {
		return new Response('Forbidden', { status: 403 });
	}

	const formData = await request.formData();
	const displayName = formData.get('displayName')?.toString().trim();
	const note = formData.get('note')?.toString().trim() || null;

	const nameError = ghostNameError(displayName);
	if (nameError) {
		return new Response(nameError, { status: 400 });
	}

	const noteError = ghostNoteError(note);
	if (noteError) {
		return new Response(noteError, { status: 400 });
	}

	const { count } = await locals.supabase
		.from('ghost_members')
		.select('id', { count: 'exact', head: true })
		.eq('project_id', projectId);

	if ((count ?? 0) >= MAX_GHOSTS_PER_PROJECT) {
		return new Response(`A project can hold at most ${MAX_GHOSTS_PER_PROJECT} ghost members`, { status: 400 });
	}

	const { data: created, error } = await locals.supabase
		.from('ghost_members')
		.insert({ project_id: projectId, display_name: displayName, note })
		.select(GHOST_COLUMNS)
		.single();

	if (error) {
		return new Response(`Failed to add ghost member: ${error.message}`, { status: 500 });
	}

	return Response.json(created as GhostMemberRow);
};
