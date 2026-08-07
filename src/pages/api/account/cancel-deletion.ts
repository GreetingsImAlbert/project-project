import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getSupabaseAdmin } from '../../../lib/supabase/admin';
import { errorResponse } from '../../../lib/error-report';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
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
		return errorResponse({
			request,
			userId,
			privateMessage: `Failed to cancel deletion: ${profileError.message}`,
			action: 'Failed to cancel deletion.',
			context: { stage: 'profile-update' },
		});
	}

	const { error: metadataError } = await admin.auth.admin.updateUserById(userId, {
		app_metadata: { pending_deletion_at: null },
	});

	if (metadataError) {
		return errorResponse({
			request,
			userId,
			privateMessage: `Failed to cancel deletion: ${metadataError.message}`,
			action: 'Failed to cancel deletion.',
			context: { stage: 'metadata-update' },
		});
	}

	// The session that's here right now was minted with the stale claim (that's
	// why middleware let it reach this page) — refresh so the very next request
	// reads the cleared one instead of waiting out the access token's lifetime.
	await locals.supabase.auth.refreshSession();

	return Response.json({ ok: true });
};
