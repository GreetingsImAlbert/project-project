import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getSupabaseAdmin } from '../../../../lib/supabase/admin';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals, redirect }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const projectId = params.id;

	// only the owner can add members
	const { data: project } = await locals.supabase
		.from('projects')
		.select('owner_id')
		.eq('id', projectId)
		.single();

	if (!project || project.owner_id !== locals.user.id) {
		return new Response('Forbidden', { status: 403 });
	}

	const formData = await request.formData();
	const email = formData.get('email')?.toString();
	const role = formData.get('role')?.toString();

	if (!email || !role || !['editor', 'viewer'].includes(role)) {
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

	// insert uses the session-aware client — the new RLS policy allows this
	// specifically because locals.user is confirmed the project owner
	const { error: insertError } = await locals.supabase
		.from('project_members')
		.insert({ project_id: projectId, user_id: targetUser.id, role });

	if (insertError) {
		return new Response(`Failed to add member: ${insertError.message}`, { status: 500 });
	}

	return redirect(`/projects/${projectId}`);
};