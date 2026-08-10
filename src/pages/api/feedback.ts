import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getSupabaseAdmin } from '../../lib/supabase/admin';
import { logError } from '../../lib/error-report';
import { parseFeedbackInput } from '../../lib/feedback';

export const prerender = false;

// User-typed counterpart to log-error.ts's crash reports — same table, same
// admin-only read at /admin/errors, distinguished by source: 'feedback' so a
// deliberate note doesn't get mixed in with what the app caught on its own.
export const POST: APIRoute = async ({ request, locals }) => {
	const body = await request.json().catch(() => null);
	const input = parseFeedbackInput(body);

	if (!input) {
		return new Response('Missing message or invalid feedback kind', { status: 400 });
	}

	const admin = getSupabaseAdmin(env);
	const reportId = await logError(admin, {
		message: input.message,
		source: 'feedback',
		path: input.path,
		userId: locals.user?.id ?? null,
		context: { feedbackKind: input.kind },
	});

	return Response.json({ reportId });
};
