import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getSupabaseAdmin } from '../../../lib/supabase/admin';
import { wouldExceedUserLimit } from '../../../lib/user-limit';
import { displayNameProblem } from '../../../lib/account-validation';
import { alertSignup } from '../../../lib/signup-alert';
import { checkAuthRateLimit } from '../../../lib/auth-rate-limit';
import { authErrorResponse, wantsJson } from '../../../lib/auth-response';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals, redirect }) => {
	const formData = await request.formData();
	const email = formData.get('email')?.toString();
	const password = formData.get('password')?.toString();
	const displayName = formData.get('displayName')?.toString();

	const blocked = await checkAuthRateLimit(env.SIGNUP_RATE_LIMITER!, request, email);
	if (blocked) return blocked;

	if (!email || !password || !displayName) {
		return authErrorResponse(request, 'Missing required fields', 400);
	}

	const trimmedDisplayName = displayName.trim();
	const nameProblem = displayNameProblem(trimmedDisplayName);
	if (nameProblem) {
		return authErrorResponse(request, nameProblem, 400);
	}

	const admin = getSupabaseAdmin(env);
	if (await wouldExceedUserLimit(admin)) {
		return authErrorResponse(request, 'Signups are full', 403);
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
		if (signUpError?.message?.includes('Signups are full')) {
			return authErrorResponse(request, 'Signups are full', 403);
		}
		return authErrorResponse(request, `Signup failed: ${signUpError?.message ?? 'Could not create account'}`, 400);
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
		if (wantsJson(request)) {
			return Response.json({
				requiresEmailConfirmation: true,
				message: 'Account created! Check your email for a confirmation link before logging in.',
			});
		}

		return redirect('/login?checkEmail=1', 303);
	}

	if (wantsJson(request)) return Response.json({ redirect: '/' });

	// 303 so the POST is followed by a GET (see logout.ts).
	return redirect('/', 303);
};
