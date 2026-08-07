import type { APIRoute } from 'astro';
import { canEditMoney } from '../../../../../../lib/money-access';
import {
	GHOST_COLUMNS,
	ghostNameError,
	ghostNoteError,
	type GhostMemberRow,
} from '../../../../../../lib/ghost-members';
import { errorResponse } from '../../../../../../lib/error-report';

export const prerender = false;

/**
 * Renames a ghost member, re-notes it, sets its share of the split, or any
 * combination — every field is optional and only the ones actually posted are
 * written. The contributions table saves a split by posting `contributionPercent`
 * alone, which is why this doubles as the ghost half of the member contribution
 * endpoint rather than there being a fourth route for it.
 */
export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const projectId = params.id;
	const ghostId = params.ghostId;

	if (!(await canEditMoney(locals.supabase, projectId!, locals.user.id))) {
		return new Response('Forbidden', { status: 403 });
	}

	const formData = await request.formData();
	const patch: Record<string, string | number | null> = {};

	if (formData.has('displayName')) {
		const displayName = formData.get('displayName')?.toString().trim();
		const nameError = ghostNameError(displayName);
		if (nameError) {
			return new Response(nameError, { status: 400 });
		}
		patch.display_name = displayName!;
	}

	if (formData.has('note')) {
		const note = formData.get('note')?.toString().trim() || null;
		const noteError = ghostNoteError(note);
		if (noteError) {
			return new Response(noteError, { status: 400 });
		}
		patch.note = note;
	}

	if (formData.has('contributionPercent')) {
		const raw = formData.get('contributionPercent')?.toString().trim();
		if (!raw) {
			return new Response('Contribution percent is required', { status: 400 });
		}
		const contributionPercent = Number(raw);
		if (!Number.isFinite(contributionPercent) || contributionPercent < 0 || contributionPercent > 100) {
			return new Response('Must be between 0 and 100', { status: 400 });
		}
		patch.contribution_percent = contributionPercent;
	}

	if (Object.keys(patch).length === 0) {
		return new Response('Nothing to update', { status: 400 });
	}

	const { data: updated, error } = await locals.supabase
		.from('ghost_members')
		.update(patch)
		.eq('id', ghostId)
		.eq('project_id', projectId)
		.select(GHOST_COLUMNS)
		.maybeSingle();

	if (error) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to update ghost member: ${error.message}`,
			action: 'Failed to update ghost member.',
			context: { projectId: projectId ?? null, ghostId: ghostId ?? null },
		});
	}
	if (!updated) {
		return new Response('Ghost member not found', { status: 404 });
	}

	return Response.json(updated as GhostMemberRow);
};
