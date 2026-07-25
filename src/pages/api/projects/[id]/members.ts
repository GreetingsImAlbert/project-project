import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getSupabaseAdmin } from '../../../../lib/supabase/admin';

export const prerender = false;

const BASE_ROLES = ['editor', 'viewer'];

// Only allow bouncing back to an in-app project path so a crafted return_to
// can't turn this redirect into an open redirect.
function safeReturnTo(value: string | undefined, fallback: string): string {
	if (value && value.startsWith('/projects/')) {
		return value;
	}
	return fallback;
}

export const POST: APIRoute = async ({ params, request, locals, redirect }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const projectId = params.id;

	// only the owner can add members or change their roles
	const { data: project } = await locals.supabase
		.from('projects')
		.select('owner_id')
		.eq('id', projectId)
		.single();

	if (!project || project.owner_id !== locals.user.id) {
		return new Response('Forbidden', { status: 403 });
	}

	const formData = await request.formData();
	const returnTo = safeReturnTo(formData.get('returnTo')?.toString(), `/projects/${projectId}`);

	// Two shapes post to this endpoint: adding a new member (identified by email)
	// and updating an existing member's role/auditor flag (identified by user_id).
	const existingUserId = formData.get('userId')?.toString();

	if (existingUserId) {
		if (existingUserId === locals.user.id) {
			return new Response('Cannot change your own role', { status: 400 });
		}

		const role = formData.get('role')?.toString();
		// A checkbox only posts when checked, so absence means false.
		const isAuditor = formData.get('isAuditor') === 'on';

		if (!role || !BASE_ROLES.includes(role)) {
			return new Response('Invalid role', { status: 400 });
		}

		// is_auditor isn't in the generated Database types until update-types runs,
		// so the update payload is cast to sidestep the column-name check.
		const { error: updateError } = await locals.supabase
			.from('project_members')
			.update({ role, is_auditor: isAuditor } as never)
			.eq('project_id', projectId)
			.eq('user_id', existingUserId);

		if (updateError) {
			return new Response(`Failed to update member: ${updateError.message}`, { status: 500 });
		}

		// The role editor is a client island (MemberManager.svelte) that updates its
		// own state on success, so there's nothing to redirect to — unlike the
		// add-member path below, which is a plain form POST.
		return new Response(null, { status: 204 });
	}

	const email = formData.get('email')?.toString();
	const role = formData.get('role')?.toString();
	const isAuditor = formData.get('isAuditor') === 'on';

	if (!email || !role || !BASE_ROLES.includes(role)) {
		return new Response('Invalid email or role', { status: 400 });
	}

	// admin client used narrowly, just for the exact-match email lookup
	const admin = getSupabaseAdmin(env);
	const { data: targetUser, error: lookupError } = await admin
		.from('profiles')
		.select('id')
		.eq('email', email.trim().toLowerCase())
		.single();

	if (lookupError || !targetUser) {
		return new Response('No user found with that email', { status: 404 });
	}

	// insert uses the session-aware client — the RLS policy allows this
	// specifically because locals.user is confirmed the project owner
	const { error: insertError } = await locals.supabase
		.from('project_members')
		.insert({ project_id: projectId, user_id: targetUser.id, role, is_auditor: isAuditor } as never);

	if (insertError) {
		return new Response(`Failed to add member: ${insertError.message}`, { status: 500 });
	}

	return redirect(returnTo);
};
