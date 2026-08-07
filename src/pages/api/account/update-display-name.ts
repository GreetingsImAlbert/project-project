import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getSupabaseAdmin } from '../../../lib/supabase/admin';
import { displayNameProblem } from '../../../lib/account-validation';
import { errorResponse } from '../../../lib/error-report';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const formData = await request.formData();
	const displayName = formData.get('displayName')?.toString().trim() ?? '';

	const problem = displayNameProblem(displayName);
	if (problem) {
		return new Response(problem, { status: 400 });
	}

	// The name lives in two places and both have to move together: profiles.display_name
	// is what every other member sees, and auth user_metadata.display_name is what the
	// JWT carries for the header (see middleware.ts).

	// profiles has no UPDATE policy at all, and adding a blanket "users can update their
	// own row" one would hand every client a way to set is_admin on itself — so this half
	// goes through the service-role client with both the column list and the row pinned
	// server-side: only display_name, only the caller's own id.
	const admin = getSupabaseAdmin(env);

	const { data: previous, error: readError } = await admin
		.from('profiles')
		.select('display_name')
		.eq('id', locals.user.id)
		.single();

	if (readError || !previous) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to update display name: ${readError?.message ?? 'profile not found'}`,
			action: 'Failed to update display name.',
		});
	}

	const { error: profileError } = await admin
		.from('profiles')
		.update({ display_name: displayName })
		.eq('id', locals.user.id);

	if (profileError) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to update display name: ${profileError.message}`,
			action: 'Failed to update display name.',
		});
	}

	const { error: authError } = await locals.supabase.auth.updateUser({
		data: { display_name: displayName },
	});

	if (authError) {
		// Leaving the two halves disagreeing is worse than not changing anything —
		// the profile row would say one name and every JWT another.
		await admin.from('profiles').update({ display_name: previous.display_name }).eq('id', locals.user.id);
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to update display name: ${authError.message}`,
			action: 'Failed to update display name.',
		});
	}

	// updateUser writes the metadata to the auth record but does not mint a new access
	// token, and getClaims() keeps reading the old JWT until it expires — up to an hour
	// of the header showing the previous name. Refreshing re-issues the token from the
	// stored user, so the new name is in the cookie the very next request reads.
	await locals.supabase.auth.refreshSession();

	return Response.json({ displayName });
};
