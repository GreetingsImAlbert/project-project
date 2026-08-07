import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from './supabase/database.types';
import { env } from 'cloudflare:workers';
import { getSupabaseAdmin } from './supabase/admin';

// Crockford-ish alphabet, minus 0/O/1/I/L — meant to be read aloud or typed
// back by a user, so visually ambiguous characters are out.
const ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const ID_LENGTH = 8;

export function generateReportId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
	let id = '';
	for (const byte of bytes) {
		id += ID_ALPHABET[byte % ID_ALPHABET.length];
	}
	return id;
}

export interface ErrorReportInput {
	message: string;
	stack?: string | null;
	source: 'server' | 'client' | 'feedback';
	method?: string | null;
	path?: string | null;
	url?: string | null;
	userId?: string | null;
	context?: Record<string, Json> | null;
}

// Logs an unexpected error and returns the short id to hand back to whoever
// hit it. Never throws itself — a broken logging path must not mask the
// original error or take down the request/response that triggered it.
export async function logError(admin: SupabaseClient<Database>, input: ErrorReportInput): Promise<string> {
	const id = generateReportId();
	const { error } = await admin.from('error_reports').insert({
		id,
		message: input.message.slice(0, 2000),
		stack: input.stack?.slice(0, 8000) ?? null,
		source: input.source,
		method: input.method ?? null,
		path: input.path ?? null,
		url: input.url ?? null,
		user_id: input.userId ?? null,
		context: input.context ?? null,
	});
	if (error) {
		console.error(`[error-report] failed to persist report ${id}:`, error.message, '| original error:', input.message);
	}
	return id;
}

export interface RouteErrorOptions {
	request: Request;
	userId?: string | null;
	// The raw error message, logged privately — never shown to the caller.
	privateMessage: string;
	// Safe public wording describing the failed action, ending with a period.
	// e.g. "Failed to save file." — becomes "Failed to save file. Reference ID: ABC12345"
	action: string;
	context?: Record<string, Json> | null;
	status?: 500 | 502;
}

// Logs an unexpected server or upstream failure through logError and returns a
// plain-text 500/502 response carrying only the report id — never the raw
// database/upstream message, which can leak schema details or secrets.
export async function errorResponse(options: RouteErrorOptions): Promise<Response> {
	const { request, userId, privateMessage, action, context, status = 500 } = options;
	const reportId = await logError(getSupabaseAdmin(env), {
		message: privateMessage,
		source: 'server',
		method: request.method,
		path: new URL(request.url).pathname,
		userId,
		context,
	});
	return new Response(`${action} Reference ID: ${reportId}`, { status });
}
