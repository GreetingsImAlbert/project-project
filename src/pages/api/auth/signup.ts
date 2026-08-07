import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getSupabaseAdmin } from '../../../lib/supabase/admin';
import { wouldExceedUserLimit } from '../../../lib/user-limit';
import { displayNameProblem } from '../../../lib/account-validation';
import { alertSignup } from '../../../lib/signup-alert';
import { checkAuthRateLimit } from '../../../lib/auth-rate-limit';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals, redirect }) => {
	const formData = await request.formData();
	const email = formData.get('email')?.toString();
	const password = formData.get('password')?.toString();
	const displayName = formData.get('displayName')?.toString();

	const blocked = await checkAuthRateLimit(env.SIGNUP_RATE_LIMITER, request, email);
	if (blocked) return blocked;

	if (!email || !password || !displayName) {
		return new Response('Missing required fields', { status: 400 });
	}

	const trimmedDisplayName = displayName.trim();
	const nameProblem = displayNameProblem(trimmedDisplayName);
	if (nameProblem) {
		return new Response(nameProblem, { status: 400 });
	}

	const admin = getSupabaseAdmin(env);
	if (await wouldExceedUserLimit(admin)) {
		return new Response('Signups are full', { status: 403 });
	}

	const { data, error: signUpError } = await locals.supabase.auth.signUp({
        email: email.trim().toLowerCase(),
        password,
        options: {
            data: { display_name: trimmedDisplayName },
            emailRedirectTo: new URL('/login', request.url).toString(),
        }
    });

	if (signUpError || !data.user) {
		// Rare race: two signups pass the count check above in the same instant, and
		// the DB-level advisory-lock check in the on_auth_user_created trigger (see
		// SCHEMA.md) is the one that actually catches it.
		if (signUpError?.message.includes('Signups are full')) {
			return new Response('Signups are full', { status: 403 });
		}
		return new Response(`Signup failed: ${signUpError?.message}`, { status: 400 });
	}

	// When email confirmations are on, Supabase deliberately returns a look-alike
	// success (a user object, no error, no session) for an email that's already
	// registered and confirmed — an empty `identities` array is its documented
	// signal for that case. Keeping the same response preserves that anti-
	// enumeration protection; the alert is skipped since no account was created.
	const alreadyRegistered = data.user.identities?.length === 0;
	if (!alreadyRegistered) {
		await alertSignup(env, data.user.email ?? email, trimmedDisplayName, !data.session);
	}

	// No session means Supabase requires email confirmation before the account
	// is usable — send the user back to login with a message instead of
	// silently bouncing them there via the auth redirect.
	if (!data.session) {
		return redirect('/login?checkEmail=1', 303);
	}

	// 303 so the POST is followed by a GET (see logout.ts).
	return redirect('/', 303);
};