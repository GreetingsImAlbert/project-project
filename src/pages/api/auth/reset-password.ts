import type { APIRoute } from 'astro';
import { createStatelessSupabaseClient } from '../../../lib/supabase/stateless';
import { passwordProblem } from '../../../lib/account-validation';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
	const formData = await request.formData();
	const accessToken = formData.get('accessToken')?.toString() ?? '';
	const refreshToken = formData.get('refreshToken')?.toString() ?? '';
	const password = formData.get('password')?.toString() ?? '';

	if (!accessToken || !refreshToken) {
		return new Response('This reset link is no longer usable. Request a new one.', { status: 400 });
	}

	const problem = passwordProblem(password);
	if (problem) {
		return new Response(problem, { status: 400 });
	}

	// The whole point of the stateless client here: the recovery session exists in this
	// client's memory for the length of this request and is never written to a cookie.
	// Proving you can read the reset email therefore does not sign you in — it only
	// earns the right to set a password, which is the only thing this endpoint does.
	const supabase = createStatelessSupabaseClient();

	const { error: sessionError } = await supabase.auth.setSession({
		access_token: accessToken,
		refresh_token: refreshToken,
	});

	if (sessionError) {
		return new Response('This reset link has expired or has already been used. Request a new one.', { status: 401 });
	}

	const { error: updateError } = await supabase.auth.updateUser({ password });

	if (updateError) {
		return new Response(`Failed to set the new password: ${updateError.message}`, { status: 400 });
	}

	// 'global', not 'others': the recovery session is itself something that was handed
	// out before the new password existed, so it goes too. Nothing that predates this
	// change survives it, on any device.
	const { error: revokeError } = await supabase.auth.signOut({ scope: 'global' });

	if (revokeError) {
		return new Response(
			'Password changed, but the existing sessions could not be revoked. Sign in and change it again from the account page.',
			{ status: 500 }
		);
	}

	// Covers the case where this browser was already signed in when the reset link was
	// opened: the refresh token behind that cookie was just revoked above, so clear the
	// cookie rather than leave a half-dead session attached to the reset page. Scope
	// 'local' is storage-only — it doesn't try to revoke anything a second time.
	try {
		await locals.supabase.auth.signOut({ scope: 'local' });
	} catch {
		// No session on this browser is the ordinary case here, not a failure.
	}

	return Response.json({ ok: true });
};
