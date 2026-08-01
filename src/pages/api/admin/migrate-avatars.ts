import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { isAdminUser } from '../../../lib/admin-guard';
import { getSupabaseAdmin } from '../../../lib/supabase/admin';
import {
	CUSTOM_AVATAR_BUCKET,
	CUSTOM_AVATAR_MARKER,
	avatarStoragePath,
	isCustomAvatarDataUrl,
	parseCustomAvatarDataUrl,
} from '../../../lib/avatars';

export const prerender = false;

export const POST: APIRoute = async ({ locals }) => {
	if (!locals.user) return new Response('Unauthorized', { status: 401 });
	if (!(await isAdminUser(locals.supabase, locals.user.id))) return new Response('Forbidden', { status: 403 });

	const admin = getSupabaseAdmin(env);
	const { data: profiles, error: profileReadError } = await admin.from('profiles').select('id, avatar');
	if (profileReadError) return new Response(`Failed to read profiles: ${profileReadError.message}`, { status: 500 });

	let migrated = 0;
	let skipped = 0;
	const failures: string[] = [];

	for (const profile of profiles ?? []) {
		if (!isCustomAvatarDataUrl(profile.avatar)) {
			skipped += 1;
			continue;
		}

		const parsed = parseCustomAvatarDataUrl(profile.avatar);
		if (!parsed) {
			failures.push(`${profile.id}: invalid legacy image`);
			continue;
		}

		const path = avatarStoragePath(profile.id, parsed.mimeType);
		const { error: uploadError } = await admin.storage.from(CUSTOM_AVATAR_BUCKET).upload(path, parsed.bytes, {
			contentType: parsed.mimeType,
			cacheControl: '31536000',
			upsert: false,
		});
		if (uploadError) {
			failures.push(`${profile.id}: ${uploadError.message}`);
			continue;
		}

		const { error: profileError } = await admin.from('profiles').update({ avatar: path }).eq('id', profile.id);
		if (profileError) {
			await admin.storage.from(CUSTOM_AVATAR_BUCKET).remove([path]);
			failures.push(`${profile.id}: ${profileError.message}`);
			continue;
		}

		const { data: authUser, error: authReadError } = await admin.auth.admin.getUserById(profile.id);
		if (authReadError || !authUser.user) {
			await admin.from('profiles').update({ avatar: profile.avatar }).eq('id', profile.id);
			await admin.storage.from(CUSTOM_AVATAR_BUCKET).remove([path]);
			failures.push(`${profile.id}: ${authReadError?.message ?? 'auth user not found'}`);
			continue;
		}

		const { error: authError } = await admin.auth.admin.updateUserById(profile.id, {
			user_metadata: { ...authUser.user.user_metadata, avatar: CUSTOM_AVATAR_MARKER },
		});
		if (authError) {
			await admin.from('profiles').update({ avatar: profile.avatar }).eq('id', profile.id);
			await admin.storage.from(CUSTOM_AVATAR_BUCKET).remove([path]);
			failures.push(`${profile.id}: ${authError.message}`);
			continue;
		}

		migrated += 1;
	}

	return Response.json({ migrated, skipped, failures });
};
