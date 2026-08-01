import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getSupabaseAdmin } from '../../../../../../lib/supabase/admin';

export const prerender = false;

export const POST: APIRoute = async ({ params, locals }) => {
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
	const { data: removed, error } = await admin
		.from('project_members')
		.delete()
		.eq('project_id', projectId)
		.eq('user_id', memberId)
		.select('user_id')
		.maybeSingle();

	if (error) {
		return new Response(`Failed to remove member: ${error.message}`, { status: 500 });
	}
	if (!removed) {
		return new Response('Member is not in this project', { status: 404 });
	}

	return new Response(null, { status: 204 });
};
