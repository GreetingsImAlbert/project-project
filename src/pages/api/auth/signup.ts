import type { APIRoute } from 'astro';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals, redirect }) => {
	const formData = await request.formData();
	const email = formData.get('email')?.toString();
	const password = formData.get('password')?.toString();
	const displayName = formData.get('displayName')?.toString();

	if (!email || !password || !displayName) {
		return new Response('Missing required fields', { status: 400 });
	}

	const { data, error: signUpError } = await locals.supabase.auth.signUp({ 
        email, 
        password,
        options: {
            data: { display_name: displayName }
        }
    });

	if (signUpError || !data.user) {
		return new Response(`Signup failed: ${signUpError?.message}`, { status: 400 });
	}

	return redirect('/');
};