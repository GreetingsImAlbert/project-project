import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getSupabaseAdmin } from '../../../lib/supabase/admin';

export const prerender = false;

export const POST: APIRoute = async ({ locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const admin = getSupabaseAdmin(env);
	const userId = locals.user.id;

	const { error: profileError } = await admin
		.from('profiles')
		.update({ pending_deletion_at: null })
		.eq('id', userId);

	if (profileError) {
		return new Response(`Failed to cancel deletion: ${profileError.message}`, { status: 500 });
	}

	const { error: metadataError } = await admin.auth.admin.updateUserById(userId, {
		app_metadata: { pending_deletion_at: null },
	});

	if (metadataError) {
		return new Response(`Failed to cancel deletion: ${metadataError.message}`, { status: 500 });
	}

	// The session that's here right now was minted with the stale claim (that's
	// why middleware let it reach this page) — refresh so the very next request
	// reads the cleared one instead of waiting out the access token's lifetime.
	await locals.supabase.auth.refreshSession();

	return Response.json({ ok: true });
};
