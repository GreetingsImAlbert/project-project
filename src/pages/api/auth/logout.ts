import type { APIRoute } from 'astro';

export const prerender = false;

export const POST: APIRoute = async ({ locals, redirect }) => {
	await locals.supabase.auth.signOut();
	// 303, not the default 302: this is a POST, and 303 is the status that tells the
	// browser to follow it with a GET rather than leaving that to convention.
	return redirect('/login', 303);
};