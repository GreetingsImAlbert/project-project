import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { createStatelessSupabaseClient } from '../../../lib/supabase/stateless';
import { checkAuthRateLimit } from '../../../lib/auth-rate-limit';
import { authErrorResponse, wantsJson } from '../../../lib/auth-response';

export const prerender = false;

export const POST: APIRoute = async ({ request, redirect }) => {
	const formData = await request.formData();
	const email = formData.get('email')?.toString().trim().toLowerCase();

	const blocked = await checkAuthRateLimit(env.PASSWORD_RESET_RATE_LIMITER!, request, email);
	if (blocked) return blocked;

	if (!email) {
		return authErrorResponse(request, 'Missing email', 400);
	}

	// Stateless, so the recovery link Supabase mails out is an implicit-flow one:
	// the tokens come back in the URL fragment rather than as a PKCE `?code=` that
	// only the requesting browser could redeem. See supabase/stateless.ts.
	const supabase = createStatelessSupabaseClient();

	const { error } = await supabase.auth.resetPasswordForEmail(email, {
		redirectTo: new URL('/reset-password', request.url).toString(),
	});

	if (error) {
		console.log(`[auth] password reset request failed: ${error.message}`);
	}

	// Same answer either way. Whether an address has an account here isn't something
	// an unauthenticated form should confirm, so provider failures are reported as a
	// sent mail rather than handed back as a signal. Rate-limit responses return above.
	const message = 'If an account exists for that address, a reset link is on its way. It is single-use and expires shortly — open the newest one if you asked more than once.';
	if (wantsJson(request)) return Response.json({ message });

	return redirect('/forgot-password?sent=1', 303);
};
