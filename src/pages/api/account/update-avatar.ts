import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getSupabaseAdmin } from '../../../lib/supabase/admin';
import { isAvatarId } from '../../../lib/avatars';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const formData = await request.formData();
	const raw = formData.get('avatar')?.toString() ?? '';
	// '' clears the picture back to the initial fallback; anything else has to be one of
	// the ids we ship, so the value that ends up in an <img src> is never user-authored.
	const avatar = raw === '' ? null : raw;

	if (avatar !== null && !isAvatarId(avatar)) {
		return new Response('Unknown profile picture', { status: 400 });
	}

	// Same two-places-one-write shape as update-display-name.ts: profiles.avatar is what
	// other members read, auth user_metadata.avatar is what the JWT carries so the navbar
	// can render it without a profiles round trip on every request (see middleware.ts).
	// profiles still has no UPDATE policy — this half goes through the service-role client
	// with the column list and the row both pinned server-side.
	const admin = getSupabaseAdmin(env);

	const { data: previous, error: readError } = await admin
		.from('profiles')
		.select('avatar')
		.eq('id', locals.user.id)
		.single();

	if (readError || !previous) {
		return new Response(`Failed to update profile picture: ${readError?.message ?? 'profile not found'}`, { status: 500 });
	}

	const { error: profileError } = await admin
		.from('profiles')
		.update({ avatar })
		.eq('id', locals.user.id);

	if (profileError) {
		return new Response(`Failed to update profile picture: ${profileError.message}`, { status: 500 });
	}

	const { error: authError } = await locals.supabase.auth.updateUser({
		data: { avatar },
	});

	if (authError) {
		await admin.from('profiles').update({ avatar: previous.avatar }).eq('id', locals.user.id);
		return new Response(`Failed to update profile picture: ${authError.message}`, { status: 500 });
	}

	// updateUser doesn't mint a new access token, and getClaims() keeps reading the old
	// JWT until it expires — refreshing puts the new avatar in the cookie the very next
	// request reads, same reason as update-display-name.ts.
	await locals.supabase.auth.refreshSession();

	return Response.json({ avatar });
};
