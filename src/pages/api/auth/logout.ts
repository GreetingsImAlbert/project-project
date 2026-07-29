import type { APIRoute } from 'astro';
import { REMEMBER_ME_COOKIE } from '../../../lib/supabase/server';

export const prerender = false;

export const POST: APIRoute = async ({ locals, redirect, cookies }) => {
	await locals.supabase.auth.signOut();
	cookies.delete(REMEMBER_ME_COOKIE, { path: '/' });
	// 303, not the default 302: this is a POST, and 303 is the status that tells the
	// browser to follow it with a GET rather than leaving that to convention.
	return redirect('/login', 303);
};