import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { createStatelessSupabaseClient } from '../../../lib/supabase/stateless';
import { passwordProblem } from '../../../lib/account-validation';
import { getSupabaseAdmin } from '../../../lib/supabase/admin';
import { logError } from '../../../lib/error-report';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
	if (!locals.user?.email) {
		return new Response('Unauthorized', { status: 401 });
	}

	const formData = await request.formData();
	const currentPassword = formData.get('currentPassword')?.toString() ?? '';
	const newPassword = formData.get('newPassword')?.toString() ?? '';

	if (!currentPassword) {
		return new Response('Enter your current password', { status: 400 });
	}

	const problem = passwordProblem(newPassword);
	if (problem) {
		return new Response(problem, { status: 400 });
	}

	if (newPassword === currentPassword) {
		return new Response('New password must be different from the current one', { status: 400 });
	}

	// Proof of the current password on a client that stores nothing: the session this
	// sign-in mints is held in that client's memory and never reaches a cookie, so
	// checking the password can't disturb the session the caller is using right now.
	const check = createStatelessSupabaseClient();
	const { error: signInError } = await check.auth.signInWithPassword({
		email: locals.user.email,
		password: currentPassword,
	});

	if (signInError) {
		return new Response('Current password is incorrect', { status: 403 });
	}

	const { error: updateError } = await locals.supabase.auth.updateUser({ password: newPassword });

	if (updateError) {
		return new Response(`Failed to change password: ${updateError.message}`, { status: 400 });
	}

	// Everything that signed in with the old password is now stale, including the
	// throwaway session the check above just created. Scope 'others' spares the caller's
	// own session, so changing your password doesn't log you out of the page you changed
	// it on — every other device has to sign in again.
	const { error: revokeError } = await locals.supabase.auth.signOut({ scope: 'others' });

	if (revokeError) {
		const reportId = await logError(getSupabaseAdmin(env), {
			message: `Failed to sign out other sessions after password change: ${revokeError.message}`,
			source: 'server',
			method: request.method,
			path: new URL(request.url).pathname,
			userId: locals.user.id,
		});
		return new Response(
			`Password changed, but the other sessions could not be signed out. Change it again to retry the sign-out. Reference ID: ${reportId}`,
			{ status: 500 }
		);
	}

	return Response.json({ ok: true });
};
