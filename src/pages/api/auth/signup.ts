import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getSupabaseAdmin } from '../../../lib/supabase/admin';
import { wouldExceedUserLimit } from '../../../lib/user-limit';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals, redirect }) => {
	const formData = await request.formData();
	const email = formData.get('email')?.toString();
	const password = formData.get('password')?.toString();
	const displayName = formData.get('displayName')?.toString();

	if (!email || !password || !displayName) {
		return new Response('Missing required fields', { status: 400 });
	}

	const admin = getSupabaseAdmin(env);
	if (await wouldExceedUserLimit(admin)) {
		return new Response('Signups are full', { status: 403 });
	}

	const { data, error: signUpError } = await locals.supabase.auth.signUp({
        email: email.trim().toLowerCase(),
        password,
        options: {
            data: { display_name: displayName },
            emailRedirectTo: new URL('/login', request.url).toString(),
        }
    });

	if (signUpError || !data.user) {
		return new Response(`Signup failed: ${signUpError?.message}`, { status: 400 });
	}

	// No session means Supabase requires email confirmation before the account
	// is usable — send the user back to login with a message instead of
	// silently bouncing them there via the auth redirect.
	if (!data.session) {
		return redirect('/login?checkEmail=1');
	}

	return redirect('/');
};