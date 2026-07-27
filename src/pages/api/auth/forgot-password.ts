import type { APIRoute } from 'astro';
import { createStatelessSupabaseClient } from '../../../lib/supabase/stateless';

export const prerender = false;

export const POST: APIRoute = async ({ request, redirect }) => {
	const formData = await request.formData();
	const email = formData.get('email')?.toString().trim().toLowerCase();

	if (!email) {
		return new Response('Missing email', { status: 400 });
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
	// an unauthenticated form should confirm, so a rejected address and a rate-limit
	// error are both reported as a sent mail rather than handed back as a signal.
	return redirect('/forgot-password?sent=1', 303);
};
