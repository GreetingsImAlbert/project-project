import { AwsClient } from 'aws4fetch';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database.types';
import { appendJournalEntry } from './journal-entries';
import { createJournalCronReport, type JournalCronPhase, type JournalCronOutcome } from './journal-cron-report';
import { retryJournalOperationWithIncident } from './journal-retry';
import { logError } from './error-report';
import { wouldExceedStorageQuota } from './r2-quota';
import { appToday } from './today';

// Every project gets at most one of these — the database's
// `journal_file_unique_per_project` partial index actually enforces that; this
// filename is just what a member sees in the Files list.
export const JOURNAL_FILENAME = 'Journal.md';
export const JOURNAL_MIME = 'text/markdown';

// A day's worth of notes, not a document — generous, but nowhere near the 1MB
// the general file editor allows (file-kind.ts's MAX_VIEWABLE_BYTES). Enforced
// both by the draft API and the database's journal_drafts check constraint.
export const MAX_DRAFT_CHARS = 50_000;

interface SupabaseFailure {
	code?: string;
	details?: string;
	hint?: string;
	message: string;
}

function supabaseFailure(error: SupabaseFailure, status: number): Error {
	return Object.assign(new Error(error.message), error, { status });
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error);
}

export interface JournalCronContext {
	cron?: string | null;
	scheduledTime?: number;
}

async function reportJournalCronIncident(
	admin: SupabaseClient<Database>,
	env: Env,
	context: Required<JournalCronContext>,
	phase: JournalCronPhase,
	outcome: JournalCronOutcome,
	attempts: number,
	error: unknown,
	projectId?: string,
): Promise<void> {
	await logError(admin, createJournalCronReport({
		phase,
		outcome,
		attempts,
		error,
		cron: context.cron,
		scheduledAt: new Date(context.scheduledTime).toISOString(),
		projectId,
	}), { outbox: env.R2_BUCKET });
}

function r2Client(env: Env) {
	return new AwsClient({
		accessKeyId: env.R2_ACCESS_KEY_ID,
		secretAccessKey: env.R2_SECRET_ACCESS_KEY,
		service: 's3',
		region: 'auto',
	});
}

function objectUrlFor(env: Env, r2Key: string) {
	return `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${r2Key}`;
}

export async function readJournalObject(env: Env, r2Key: string): Promise<string> {
	const object = await env.R2_BUCKET!.get(r2Key);
	if (!object) return '';
	return new TextDecoder('utf-8').decode(await object.arrayBuffer());
}

// Returns the size R2 actually recorded, same rule as every other write in this
// app (confirm.ts, content.ts's PUT) — never the length of what was sent.
async function writeJournalObject(env: Env, r2Key: string, content: string): Promise<number> {
	const r2 = r2Client(env);
	const bytes = new TextEncoder().encode(content);

	const putRes = await r2.fetch(objectUrlFor(env, r2Key), {
		method: 'PUT',
		headers: { 'content-type': `${JOURNAL_MIME}; charset=utf-8` },
		body: bytes,
	});
	if (!putRes.ok) {
		throw Object.assign(new Error(`Failed to write journal object: ${putRes.status} ${await putRes.text()}`), { status: putRes.status });
	}

	const headRes = await r2.fetch(objectUrlFor(env, r2Key), { method: 'HEAD' });
	return Number(headRes.headers.get('content-length') ?? bytes.byteLength);
}

export interface JournalFileRow {
	id: string;
	r2_key: string;
	size_bytes: number | null;
}

// Lazily creates the project's one Journal file the first time anyone opens the
// page. Runs on the admin (service-role) client rather than the caller's own —
// the file is attributed to the project owner's storage no matter who happens to
// be the first owner/editor to visit, and the files insert policy (uploaded_by =
// auth.uid()) has no way to let a non-owner editor insert a row owned by someone
// else. The role/membership check that would normally be RLS's job is done by
// the caller before this runs (see journal.astro).
export async function ensureJournalFile(
	admin: SupabaseClient<Database>,
	env: Env,
	projectId: string,
	ownerId: string,
): Promise<JournalFileRow> {
	const { data: existing } = await admin
		.from('files')
		.select('id, r2_key, size_bytes')
		.eq('project_id', projectId)
		.eq('is_journal', true)
		.maybeSingle();

	if (existing) return existing;

	const r2Key = `${projectId}/${crypto.randomUUID()}-${JOURNAL_FILENAME}`;
	const sizeBytes = await writeJournalObject(env, r2Key, '');

	const { data: created, error } = await admin
		.from('files')
		.insert({
			project_id: projectId,
			uploaded_by: ownerId,
			filename: JOURNAL_FILENAME,
			r2_key: r2Key,
			mime_type: JOURNAL_MIME,
			size_bytes: sizeBytes,
			is_journal: true,
		})
		.select('id, r2_key, size_bytes')
		.single();

	if (error || !created) {
		throw new Error(`Failed to create journal file: ${error?.message ?? 'unknown error'}`);
	}

	return created;
}

export interface JournalDraftRow {
	draft_date: string;
	content: string;
}

// Lazily creates the project's one draft row, same idea as ensureJournalFile but
// on the caller's own RLS-scoped client: a draft carries no per-user attribution
// (unlike the file, nothing here is charged to anyone's storage), so an ordinary
// owner/editor insert is all it needs.
export async function ensureJournalDraft(
	supabase: SupabaseClient<Database>,
	projectId: string,
): Promise<JournalDraftRow> {
	const { data: existing } = await supabase
		.from('journal_drafts')
		.select('draft_date, content')
		.eq('project_id', projectId)
		.maybeSingle();

	if (existing) return existing;

	const { data: created, error } = await supabase
		.from('journal_drafts')
		.insert({ project_id: projectId, draft_date: appToday(), content: '' })
		.select('draft_date, content')
		.single();

	if (error || !created) {
		throw new Error(`Failed to create journal draft: ${error?.message ?? 'unknown error'}`);
	}

	return created;
}

// The cron job's actual work, run once at Manila midnight for every project whose
// draft has fallen behind today — normally just the drafts dated yesterday, but
// a missed run (a deploy, a Cloudflare incident) leaves older ones queued too, and
// this catches them up the same way. Runs entirely on the admin client: there's no
// caller session to scope RLS to, and every project's draft needs finalizing in
// the same pass.
export async function finalizeStaleDrafts(
	admin: SupabaseClient<Database>,
	env: Env,
	cronContext: JournalCronContext = {},
): Promise<void> {
	const today = appToday();
	const incidentContext: Required<JournalCronContext> = {
		cron: cronContext.cron ?? null,
		scheduledTime: cronContext.scheduledTime ?? Date.now(),
	};
	let staleDrafts: Array<{ project_id: string; draft_date: string; content: string }> | null = null;
	let readAttempts = 0;

	try {
		staleDrafts = await retryJournalOperationWithIncident(async (attempt) => {
			readAttempts = attempt;
			const { data, error, status } = await admin
				.from('journal_drafts')
				.select('project_id, draft_date, content')
				.lt('draft_date', today);

			if (error) throw supabaseFailure(error, status);
			return data;
		}, {
			onRetry: (error, attempt, delayMs) => {
				console.warn(`[journal] failed to read stale drafts (attempt ${attempt}/4): ${errorMessage(error)}; retrying in ${delayMs}ms`);
			},
			onIncident: ({ outcome, attempts, error }) => reportJournalCronIncident(
				admin, env, incidentContext, 'read-stale-drafts', outcome, attempts, error,
			),
		});
	} catch (error) {
		console.error(`[journal] failed to read stale drafts after ${readAttempts} attempt${readAttempts === 1 ? '' : 's'}: ${errorMessage(error)}`);
		return;
	}

	for (const draft of staleDrafts ?? []) {
		let attempts = 0;
		try {
			// Retrying the whole project is safe after any partial success: the Journal
			// append replaces its trailing section for this date, and both database
			// writes below set deterministic values.
			await retryJournalOperationWithIncident(async (attempt) => {
				attempts = attempt;
				await finalizeOneDraft(admin, env, draft.project_id, draft.draft_date, draft.content, today);
			}, {
				onRetry: (error, attempt, delayMs) => {
					console.warn(`[journal] failed to finalize project ${draft.project_id} (attempt ${attempt}/4): ${errorMessage(error)}; retrying in ${delayMs}ms`);
				},
				onIncident: ({ outcome, attempts, error }) => reportJournalCronIncident(
					admin, env, incidentContext, 'finalize-project', outcome, attempts, error, draft.project_id,
				),
			});
		} catch (err) {
			// One project's failure (a full quota, a transient R2 error) shouldn't stop the
			// rest from finalizing — this draft simply stays queued and is retried at the
			// next run, since it's still dated before `today`.
			console.error(`[journal] failed to finalize project ${draft.project_id} after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${errorMessage(err)}`);
		}
	}
}

async function finalizeOneDraft(
	admin: SupabaseClient<Database>,
	env: Env,
	projectId: string,
	draftDate: string,
	content: string,
	today: string,
): Promise<void> {
	// A day with nothing written is simply skipped — "except if there is no content
	// to be saved" — but the draft still has to move forward to today, or every empty
	// day between now and the last real entry would be retried forever.
	if (content.trim()) {
		const { data: file, error, status } = await admin
			.from('files')
			.select('id, r2_key, size_bytes, uploaded_by')
			.eq('project_id', projectId)
			.eq('is_journal', true)
			.maybeSingle();

		if (error) throw supabaseFailure(error, status);

		if (!file) {
			console.error(`[journal] project ${projectId} has a draft but no journal file — skipping`);
			return;
		}

		// uploaded_by is nullable on files generally (an uploader's account can be
		// hard-deleted — see account-deletion.ts), but never for the Journal file
		// itself: it's always charged to the project owner (see ensureJournalFile),
		// and an owner's account can't be deleted while they still own the project.
		if (!file.uploaded_by) {
			console.error(`[journal] project ${projectId}'s journal file has no uploader — skipping`);
			return;
		}

		// Charged to the file's owner (always the project owner — see ensureJournalFile),
		// same rule as content.ts's PUT. A full quota leaves the draft queued rather than
		// writing past the cap; it's retried on the next run instead of being dropped.
		const growth = new TextEncoder().encode(content).byteLength;
		if (await wouldExceedStorageQuota(admin, env, file.uploaded_by, growth)) {
			console.error(`[journal] project ${projectId}'s owner is over quota — leaving draft queued`);
			return;
		}

		const current = await readJournalObject(env, file.r2_key);
		const updated = appendJournalEntry(current, draftDate, content);
		const sizeBytes = await writeJournalObject(env, file.r2_key, updated);

		const { error: updateError, status: updateStatus } = await admin
			.from('files')
			.update({ size_bytes: sizeBytes })
			.eq('id', file.id);
		if (updateError) throw supabaseFailure(updateError, updateStatus);
	}

	const { error: resetError, status: resetStatus } = await admin
		.from('journal_drafts')
		.update({ draft_date: today, content: '', updated_by: null })
		.eq('project_id', projectId);
	if (resetError) throw supabaseFailure(resetError, resetStatus);
}
