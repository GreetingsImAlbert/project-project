import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getSupabaseAdmin } from '../../../../../../lib/supabase/admin';
import { errorResponse } from '../../../../../../lib/error-report';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const projectId = params.id;
	const memberId = params.userId;
	if (!projectId || !memberId) {
		return new Response('Project and member are required', { status: 400 });
	}

	// only the owner can remove members
	const { data: project } = await locals.supabase
		.from('projects')
		.select('owner_id')
		.eq('id', projectId)
		.single();

	if (!project || project.owner_id !== locals.user.id) {
		return new Response('Forbidden', { status: 403 });
	}

	if (memberId === project.owner_id) {
		return new Response('Cannot remove the project owner', { status: 400 });
	}

	// The owner check above is session-scoped. Use the admin client for the exact
	// mutation so an older database missing the DELETE policy cannot turn this into
	// a silent no-op; the policy is still documented below for direct DB access.
	const admin = getSupabaseAdmin(env);
	const { data: targetMembership, error: targetMembershipError } = await admin
		.from('project_members')
		.select('user_id')
		.eq('project_id', projectId)
		.eq('user_id', memberId)
		.maybeSingle();
	if (targetMembershipError) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to inspect member: ${targetMembershipError.message}`,
			action: 'Failed to remove member.',
			context: { projectId: projectId ?? null, memberId: memberId ?? null },
		});
	}
	if (!targetMembership) return new Response('Member is not in this project', { status: 404 });

	// A removed member must not retain a live personal draft. Finalized Markdown
	// stays in place under its existing visibility, so the owner can delete the
	// file later without ever receiving private content through this endpoint.
	const { data: personalJournals, error: journalError } = await admin
		.from('files')
		.select('id')
		.eq('project_id', projectId)
		.eq('uploaded_by', memberId)
		.eq('is_journal', true)
		.eq('journal_kind', 'personal')
		.is('deleted_at', null);
	if (journalError) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to inspect member journals: ${journalError.message}`,
			action: 'Failed to remove member.',
			context: { projectId: projectId ?? null, memberId: memberId ?? null },
		});
	}

	const journalIds = (personalJournals ?? []).map((journal) => journal.id);
	if (journalIds.length > 0) {
		const { error: draftError } = await admin
			.from('journal_drafts')
			.delete()
			.in('journal_file_id', journalIds);
		if (draftError) {
			return errorResponse({
				request,
				userId: locals.user.id,
				privateMessage: `Failed to freeze member journals: ${draftError.message}`,
				action: 'Failed to remove member.',
				context: { projectId: projectId ?? null, memberId: memberId ?? null },
			});
		}
	}

	const { data: removed, error } = await admin
		.from('project_members')
		.delete()
		.eq('project_id', projectId)
		.eq('user_id', memberId)
		.select('user_id')
		.maybeSingle();

	if (error) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to remove member: ${error.message}`,
			action: 'Failed to remove member.',
			context: { projectId: projectId ?? null, memberId: memberId ?? null },
		});
	}
	if (!removed) {
		return new Response('Member is not in this project', { status: 404 });
	}

	return new Response(null, { status: 204 });
};
