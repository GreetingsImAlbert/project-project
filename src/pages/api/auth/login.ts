import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { createSupabaseServerClient, REMEMBER_ME_COOKIE, REMEMBER_ME_MAX_AGE } from '../../../lib/supabase/server';
import { checkAuthRateLimit } from '../../../lib/auth-rate-limit';
import { authErrorResponse, wantsJson } from '../../../lib/auth-response';

export const prerender = false;

export const POST: APIRoute = async ({ request, redirect, cookies }) => {
    const formData = await request.formData();
    const email = formData.get('email')?.toString();
    const password = formData.get('password')?.toString();
    const rememberMe = formData.get('rememberMe') === 'on';

	const blocked = await checkAuthRateLimit(env.LOGIN_RATE_LIMITER!, request, email);
    if (blocked) return blocked;

    if (!email || !password) {
        return authErrorResponse(request, 'Missing email or password', 400);
    }

    // Must be set before signInWithPassword runs, since that's what writes the auth
    // cookies — the server client's setAll reads this cookie to decide their maxAge.
    if (rememberMe) {
        cookies.set(REMEMBER_ME_COOKIE, '1', {
            httpOnly: true,
            secure: true,
            sameSite: 'lax',
            path: '/',
            maxAge: REMEMBER_ME_MAX_AGE,
        });
    } else {
        cookies.delete(REMEMBER_ME_COOKIE, { path: '/' });
    }

    // The middleware client was created before the form was parsed and only knows
    // about incoming cookies. Pass the checkbox directly so the auth cookies written
    // by this first sign-in get the requested lifetime too.
    const loginClient = createSupabaseServerClient(request, cookies, rememberMe);
    const { error } = await loginClient.auth.signInWithPassword({ email, password });

    if (error) {
        cookies.delete(REMEMBER_ME_COOKIE, { path: '/' });
        return authErrorResponse(request, `Login failed: ${error.message}`, 401);
    }

	if (wantsJson(request)) return Response.json({ redirect: '/' });

    // 303 so the POST is followed by a GET (see logout.ts).
    return redirect('/', 303);
}
