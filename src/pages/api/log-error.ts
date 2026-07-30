import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getSupabaseAdmin } from '../../lib/supabase/admin';
import { logError } from '../../lib/error-report';

export const prerender = false;

// The client-side counterpart to middleware.ts's catch-all: a crash in the
// browser (uncaught exception, unhandled promise rejection — see
// lib/client-error-report.ts) never touches the server on its own, so it
// needs its own endpoint to land in the same error_reports table. Deliberately
// unauthenticated — a crash on the login page, before any session exists,
// still has to be reportable.
export const POST: APIRoute = async ({ request, locals }) => {
	const body = await request.json().catch(() => null) as { message?: string; stack?: string; url?: string } | null;

	if (!body?.message) {
		return new Response('Missing message', { status: 400 });
	}

	const admin = getSupabaseAdmin(env);
	const reportId = await logError(admin, {
		message: body.message,
		stack: body.stack ?? null,
		source: 'client',
		url: body.url ?? null,
		userId: locals.user?.id ?? null,
	});

	return Response.json({ reportId });
};
