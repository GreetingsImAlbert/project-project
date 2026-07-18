import type { APIRoute } from 'astro';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals, redirect }) => {
    const formData = await request.formData();
    const email = formData.get('email')?.toString();
    const password = formData.get('password')?.toString();

    if (!email || !password) {
        return new Response('Missing email or password', { status: 400 });
    }

    const { error } = await locals.supabase.auth.signInWithPassword({ email, password });

    if (error) {
        return new Response(`Login failed: ${error.message}`, { status: 401 });
    }

    return redirect('/');
}