import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getSupabaseAdmin } from '../../lib/supabase/admin';
import { logError } from '../../lib/error-report';

export const prerender = false;

// User-typed counterpart to log-error.ts's crash reports — same table, same
// admin-only read at /admin/errors, distinguished by source: 'feedback' so a
// deliberate note doesn't get mixed in with what the app caught on its own.
export const POST: APIRoute = async ({ request, locals }) => {
	const body = await request.json().catch(() => null) as { message?: string; path?: string } | null;
	const message = body?.message?.trim();

	if (!message) {
		return new Response('Missing message', { status: 400 });
	}

	const admin = getSupabaseAdmin(env);
	const reportId = await logError(admin, {
		message,
		source: 'feedback',
		path: body?.path ?? null,
		userId: locals.user?.id ?? null,
	});

	return Response.json({ reportId });
};
