import type { APIRoute } from 'astro';
import { REMEMBER_ME_COOKIE, REMEMBER_ME_MAX_AGE } from '../../../lib/supabase/server';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals, redirect, cookies }) => {
    const formData = await request.formData();
    const email = formData.get('email')?.toString();
    const password = formData.get('password')?.toString();
    const rememberMe = formData.get('rememberMe') === 'on';

    if (!email || !password) {
        return new Response('Missing email or password', { status: 400 });
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

    const { error } = await locals.supabase.auth.signInWithPassword({ email, password });

    if (error) {
        return new Response(`Login failed: ${error.message}`, { status: 401 });
    }

    // 303 so the POST is followed by a GET (see logout.ts).
    return redirect('/', 303);
}