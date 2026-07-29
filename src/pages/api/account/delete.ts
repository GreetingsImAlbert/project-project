import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getSupabaseAdmin } from '../../../lib/supabase/admin';
import { createStatelessSupabaseClient } from '../../../lib/supabase/stateless';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
	if (!locals.user?.email) {
		return new Response('Unauthorized', { status: 401 });
	}

	const formData = await request.formData();
	const password = formData.get('password')?.toString() ?? '';

	if (!password) {
		return new Response('Enter your password to confirm', { status: 400 });
	}

	// Same proof-of-password pattern as update-password.ts: a client that stores
	// no session, so checking it can't disturb the cookie this request is riding on.
	const check = createStatelessSupabaseClient();
	const { error: signInError } = await check.auth.signInWithPassword({
		email: locals.user.email,
		password,
	});

	if (signInError) {
		return new Response('Incorrect password', { status: 403 });
	}

	const admin = getSupabaseAdmin(env);
	const userId = locals.user.id;

	const { count: ownedCount } = await admin
		.from('projects')
		.select('id', { count: 'exact', head: true })
		.eq('owner_id', userId);

	if (ownedCount && ownedCount > 0) {
		return new Response(
			`You still own ${ownedCount} project(s). Transfer ownership or delete them before deleting your account.`,
			{ status: 400 },
		);
	}

	const deletionTimestamp = new Date().toISOString();

	const { error: profileError } = await admin
		.from('profiles')
		.update({ pending_deletion_at: deletionTimestamp })
		.eq('id', userId);

	if (profileError) {
		return new Response(`Failed to schedule account deletion: ${profileError.message}`, { status: 500 });
	}

	// Mirrored onto app_metadata (admin-only to write, unlike user_metadata) so
	// middleware.ts can gate on the JWT claim without a profiles round trip on
	// every request. profiles.pending_deletion_at stays the cron's source of truth.
	const { error: metadataError } = await admin.auth.admin.updateUserById(userId, {
		app_metadata: { pending_deletion_at: deletionTimestamp },
	});

	if (metadataError) {
		await admin.from('profiles').update({ pending_deletion_at: null }).eq('id', userId);
		return new Response(`Failed to schedule account deletion: ${metadataError.message}`, { status: 500 });
	}

	// Every session — including this one — has to end here: the only way back in
	// is a fresh login, which is what mints a JWT actually carrying the new claim.
	await locals.supabase.auth.signOut({ scope: 'global' });

	return Response.json({ ok: true });
};
