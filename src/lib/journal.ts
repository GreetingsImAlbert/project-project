import { AwsClient } from 'aws4fetch';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database.types';
import { appendJournalEntry, parseJournalEntries, type JournalEntry } from './journal-entries';
import { createJournalCronReport, type JournalCronPhase, type JournalCronOutcome } from './journal-cron-report';
import { retryJournalOperationWithIncident } from './journal-retry';
import { logError } from './error-report';
import { wouldExceedStorageQuota } from './r2-quota';
import { appToday } from './today';
import {
	canChangeJournalVisibility,
	canDeleteJournal,
	canEditJournal,
	canReadJournal,
	personalJournalFilename,
	type JournalAccessSubject,
	type JournalAccessTarget,
	type JournalKind,
	type JournalVisibility,
} from './journal-domain';
export {
	canChangeJournalVisibility,
	canDeleteJournal,
	canEditJournal,
	canReadJournal,
	personalJournalFilename,
} from './journal-domain';
export type { JournalAccessSubject, JournalAccessTarget, JournalKind, JournalVisibility } from './journal-domain';

// The fixed visible filename for the one active group journal per project.
export const JOURNAL_FILENAME = 'JOURNAL.md';
export const JOURNAL_MIME = 'text/markdown';
export const JOURNALS_FOLDER_NAME = 'journals';

export interface ProjectJournal {
	fileId: string;
	kind: JournalKind;
	filename: string;
	creatorId: string | null;
	creatorName: string | null;
	visibility: JournalVisibility | null;
	draft: JournalDraftRow | null;
	history: JournalEntry[];
	canRead: boolean;
	canEdit: boolean;
	canDelete: boolean;
	canChangeVisibility: boolean;
}

export interface PublicProjectJournal {
	kind: JournalKind;
	label: string;
	history: JournalEntry[];
}

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
	scope: {
		projectId?: string | null;
		journalFileId?: string | null;
		journalKind?: JournalKind | null;
	} = {},
): Promise<void> {
	await logError(admin, createJournalCronReport({
		phase,
		outcome,
		attempts,
		error,
		cron: context.cron,
		scheduledAt: new Date(context.scheduledTime).toISOString(),
		projectId: scope.projectId,
		journalFileId: scope.journalFileId,
		journalKind: scope.journalKind,
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

async function deleteJournalObject(env: Env, r2Key: string): Promise<void> {
	const response = await r2Client(env).fetch(objectUrlFor(env, r2Key), { method: 'DELETE' });
	if (!response.ok && response.status !== 404) {
		throw new Error(`Failed to remove journal object: ${response.status} ${await response.text()}`);
	}
}

interface JournalDomainFileRow extends JournalFileRow {
	filename: string;
	uploaded_by: string | null;
	journal_kind: JournalKind;
	journal_visibility: JournalVisibility | null;
	profiles: { display_name: string } | Array<{ display_name: string }> | null;
}

export interface JournalsFolderRow {
	id: string;
}

// These queries describe the journal-aware schema and remain locally explicit so
// callers can use the journal fields while older generated clients are refreshed.
export function journalSchemaClient(client: SupabaseClient<Database>): SupabaseClient<any> {
	return client as SupabaseClient<any>;
}

export async function ensureJournalsFolder(
	admin: SupabaseClient<Database>,
	projectId: string,
): Promise<JournalsFolderRow> {
	const db = journalSchemaClient(admin);
	const { data: existing, error: readError, status: readStatus } = await db
		.from('folders')
		.select('id')
		.eq('project_id', projectId)
		.eq('is_journals_folder', true)
		.maybeSingle();

	if (readError) throw supabaseFailure(readError, readStatus);
	if (existing) return existing as JournalsFolderRow;

	const { data: created, error: createError, status: createStatus } = await db
		.from('folders')
		.insert({
			project_id: projectId,
			parent_folder_id: null,
			name: JOURNALS_FOLDER_NAME,
			is_journals_folder: true,
		})
		.select('id')
		.single();

	if (!createError && created) return created as JournalsFolderRow;

	// A concurrent request may have won the partial-unique-index race.
	const { data: raced } = await db
		.from('folders')
		.select('id')
		.eq('project_id', projectId)
		.eq('is_journals_folder', true)
		.maybeSingle();
	if (raced) return raced as JournalsFolderRow;

	throw supabaseFailure(createError ?? { message: 'Failed to create journals folder' }, createStatus);
}

async function findJournalFile(
	admin: SupabaseClient<Database>,
	projectId: string,
	kind: JournalKind,
	creatorId?: string,
): Promise<JournalFileRow | null> {
	let query = journalSchemaClient(admin)
		.from('files')
		.select('id, r2_key, size_bytes')
		.eq('project_id', projectId)
		.eq('journal_kind', kind)
		.is('deleted_at', null);
	if (creatorId) query = query.eq('uploaded_by', creatorId);

	const { data, error, status } = await query.maybeSingle();
	if (error) throw supabaseFailure(error, status);
	return data as JournalFileRow | null;
}

async function createJournalFile(
	admin: SupabaseClient<Database>,
	env: Env,
	projectId: string,
	creatorId: string,
	kind: JournalKind,
	filename: string,
	visibility: JournalVisibility | null,
): Promise<JournalFileRow> {
	const folder = await ensureJournalsFolder(admin, projectId);
	const r2Key = `${projectId}/${crypto.randomUUID()}-${filename}`;
	const sizeBytes = await writeJournalObject(env, r2Key, '');

	const { data: created, error, status } = await journalSchemaClient(admin)
		.from('files')
		.insert({
			project_id: projectId,
			folder_id: folder.id,
			uploaded_by: creatorId,
			filename,
			r2_key: r2Key,
			mime_type: JOURNAL_MIME,
			size_bytes: sizeBytes,
			is_journal: true,
			is_public: false,
			journal_kind: kind,
			journal_visibility: visibility,
		})
		.select('id, r2_key, size_bytes')
		.single();

	if (!error && created) return created as JournalFileRow;

	try {
		await deleteJournalObject(env, r2Key);
	} catch (cleanupError) {
		console.error(`[journal] failed to clean up orphaned object ${r2Key}: ${errorMessage(cleanupError)}`);
	}

	// Creation is idempotent even when two first-open/create requests race.
	const raced = await findJournalFile(admin, projectId, kind, kind === 'personal' ? creatorId : undefined);
	if (raced) return raced;
	throw supabaseFailure(error ?? { message: `Failed to create ${kind} journal file` }, status);
}

export async function ensureGroupJournal(
	admin: SupabaseClient<Database>,
	env: Env,
	projectId: string,
	projectOwnerId: string,
): Promise<JournalFileRow> {
	return await findJournalFile(admin, projectId, 'group')
		?? createJournalFile(admin, env, projectId, projectOwnerId, 'group', JOURNAL_FILENAME, null);
}

export async function createPersonalJournal(
	admin: SupabaseClient<Database>,
	env: Env,
	projectId: string,
	creatorId: string,
	creatorDisplayName: string,
): Promise<JournalFileRow> {
	return await findJournalFile(admin, projectId, 'personal', creatorId)
		?? createJournalFile(
			admin,
			env,
			projectId,
			creatorId,
			'personal',
			personalJournalFilename(creatorDisplayName),
			'private',
		);
}

export interface JournalFileRow {
	id: string;
	r2_key: string;
	size_bytes: number | null;
}

export interface JournalDraftRow {
	draft_date: string;
	content: string;
}

// Lazily creates one current-day draft for the selected journal file.
export async function ensureJournalDraft(
	supabase: SupabaseClient<Database>,
	projectId: string,
	journalFileId: string,
): Promise<JournalDraftRow> {
	const db = journalSchemaClient(supabase);
	const { data: existing, error: readError, status: readStatus } = await db
		.from('journal_drafts')
		.select('draft_date, content')
		.eq('journal_file_id', journalFileId)
		.maybeSingle();

	if (readError) throw supabaseFailure(readError, readStatus);
	if (existing) return existing;

	const { data: created, error, status } = await db
		.from('journal_drafts')
		.insert({ project_id: projectId, journal_file_id: journalFileId, draft_date: appToday(), content: '' })
		.select('draft_date, content')
		.single();

	if (!error && created) return created as JournalDraftRow;

	// The journal_file_id primary key makes concurrent first opens harmless.
	const { data: raced } = await db
		.from('journal_drafts')
		.select('draft_date, content')
		.eq('journal_file_id', journalFileId)
		.maybeSingle();
	if (raced) return raced as JournalDraftRow;

	throw supabaseFailure(error ?? { message: 'Failed to create journal draft' }, status);
}

export async function loadProjectJournals(
	admin: SupabaseClient<Database>,
	env: Env,
	projectId: string,
	viewerId: string,
): Promise<ProjectJournal[]> {
	const db = journalSchemaClient(admin);
	const { data: membership, error: membershipError, status: membershipStatus } = await db
		.from('project_members')
		.select('role')
		.eq('project_id', projectId)
		.eq('user_id', viewerId)
		.maybeSingle();
	if (membershipError) throw supabaseFailure(membershipError, membershipStatus);
	if (!membership) return [];

	const { data, error, status } = await db
		.from('files')
		.select('id, filename, r2_key, size_bytes, uploaded_by, journal_kind, journal_visibility, profiles!files_uploaded_by_fkey(display_name)')
		.eq('project_id', projectId)
		.eq('is_journal', true)
		.is('deleted_at', null)
		.order('filename', { ascending: true });
	if (error) throw supabaseFailure(error, status);

	const subject: JournalAccessSubject = {
		viewerId,
		isProjectMember: true,
		role: membership.role,
	};
	const visibleFiles = ((data ?? []) as unknown as JournalDomainFileRow[]).filter((file) => canReadJournal({
		kind: file.journal_kind,
		creatorId: file.uploaded_by,
		visibility: file.journal_visibility,
	}, subject));
	if (visibleFiles.length === 0) return [];

	const fileIds = visibleFiles.map((file) => file.id);
	const { data: drafts, error: draftsError, status: draftsStatus } = await db
		.from('journal_drafts')
		.select('journal_file_id, draft_date, content')
		.in('journal_file_id', fileIds);
	if (draftsError) throw supabaseFailure(draftsError, draftsStatus);

	const draftByFileId = new Map<string, JournalDraftRow>(
		(drafts ?? []).map((draft: JournalDraftRow & { journal_file_id: string }) => [draft.journal_file_id, {
			draft_date: draft.draft_date,
			content: draft.content,
		}]),
	);

	return await Promise.all(visibleFiles.map(async (file): Promise<ProjectJournal> => {
		const target: JournalAccessTarget = {
			kind: file.journal_kind,
			creatorId: file.uploaded_by,
			visibility: file.journal_visibility,
		};
		const finalizedMarkdown = await readJournalObject(env, file.r2_key);
		const creatorProfile = Array.isArray(file.profiles) ? file.profiles[0] : file.profiles;
		return {
			fileId: file.id,
			kind: file.journal_kind,
			filename: file.filename,
			creatorId: file.uploaded_by,
			creatorName: creatorProfile?.display_name ?? null,
			visibility: file.journal_visibility,
			draft: draftByFileId.get(file.id) ?? null,
			history: parseJournalEntries(finalizedMarkdown).reverse(),
			canRead: true,
			canEdit: canEditJournal(target, subject),
			canDelete: canDeleteJournal(target, subject),
			canChangeVisibility: canChangeJournalVisibility(target, subject),
		};
	}));
}

export async function loadPublicProjectJournals(
	admin: SupabaseClient<Database>,
	env: Env,
	projectId: string,
): Promise<PublicProjectJournal[]> {
	const { data, error, status } = await journalSchemaClient(admin)
		.from('files')
		.select('r2_key, journal_kind, profiles!files_uploaded_by_fkey(display_name)')
		.eq('project_id', projectId)
		.eq('is_journal', true)
		.or('journal_kind.eq.group,and(journal_kind.eq.personal,journal_visibility.eq.public)')
		.is('deleted_at', null);
	if (error) throw supabaseFailure(error, status);

	const journals = await Promise.all(((data ?? []) as Array<{
		r2_key: string;
		journal_kind: JournalKind;
		profiles: { display_name: string } | Array<{ display_name: string }> | null;
	}>).map(async (file): Promise<PublicProjectJournal> => {
		const creatorProfile = Array.isArray(file.profiles) ? file.profiles[0] : file.profiles;
		return {
			kind: file.journal_kind,
			label: file.journal_kind === 'group' ? 'Group journal' : creatorProfile?.display_name ?? 'Personal journal',
			history: parseJournalEntries(await readJournalObject(env, file.r2_key)).reverse(),
		};
	}));

	return journals.sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === 'group' ? -1 : 1;
		return a.label.localeCompare(b.label);
	});
}

interface StaleJournalDraft {
	project_id: string;
	journal_file_id: string;
	draft_date: string;
	content: string;
	updated_at: string | null;
}

interface JournalFinalizationFile {
	id: string;
	r2_key: string;
	size_bytes: number | null;
	uploaded_by: string | null;
	journal_kind: JournalKind;
}

// The cron job's actual work, run once at Manila midnight for every journal whose
// draft has fallen behind today — normally just the drafts dated yesterday, but
// a missed run (a deploy, a Cloudflare incident) leaves older ones queued too, and
// this catches them up the same way. Runs entirely on the admin client: there's no
// caller session to scope RLS to, and each journal is finalized independently so a
// quota, R2, or database failure cannot block another journal in the same project.
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
	let staleDrafts: StaleJournalDraft[] | null = null;
	let readAttempts = 0;

	try {
		staleDrafts = await retryJournalOperationWithIncident(async (attempt) => {
			readAttempts = attempt;
			const { data, error, status } = await journalSchemaClient(admin)
				.from('journal_drafts')
				.select('project_id, journal_file_id, draft_date, content, updated_at')
				.lt('draft_date', today);

			if (error) throw supabaseFailure(error, status);
			return (data ?? []) as StaleJournalDraft[];
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
		const scope: {
			projectId: string;
			journalFileId: string;
			journalKind: JournalKind | null;
		} = {
			projectId: draft.project_id,
			journalFileId: draft.journal_file_id,
			journalKind: null,
		};
		try {
			await retryJournalOperationWithIncident(async (attempt) => {
				attempts = attempt;
				await finalizeOneDraft(admin, env, draft, today, (file) => {
					scope.journalKind = file.journal_kind;
				});
			}, {
				onRetry: (error, attempt, delayMs) => {
					console.warn(
						`[journal] failed to finalize journal ${scope.journalFileId} (${scope.journalKind ?? 'unknown'}) in project ${scope.projectId} (attempt ${attempt}/4): ${errorMessage(error)}; retrying in ${delayMs}ms`,
					);
				},
				onIncident: ({ outcome, attempts, error }) => reportJournalCronIncident(
					admin,
					env,
					incidentContext,
					'finalize-project',
					outcome,
					attempts,
					error,
					scope,
				),
			});
		} catch (err) {
			// This journal simply stays queued and is retried at the next run, since it
			// remains dated before `today`; the loop continues with every other journal.
			console.error(
				`[journal] failed to finalize journal ${scope.journalFileId} (${scope.journalKind ?? 'unknown'}) in project ${scope.projectId} after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${errorMessage(err)}`,
			);
		}
	}
}

async function finalizeOneDraft(
	admin: SupabaseClient<Database>,
	env: Env,
	draft: StaleJournalDraft,
	today: string,
	onFileLoaded?: (file: JournalFinalizationFile) => void,
): Promise<void> {
	const { data, error, status } = await journalSchemaClient(admin)
		.from('files')
		.select('id, r2_key, size_bytes, uploaded_by, journal_kind')
		.eq('id', draft.journal_file_id)
		.eq('project_id', draft.project_id)
		.eq('is_journal', true)
		.is('deleted_at', null)
		.maybeSingle();

	if (error) throw supabaseFailure(error, status);
	if (!data) {
		throw new Error(`journal file ${draft.journal_file_id} is missing or deleted`);
	}

	const journalKind = data.journal_kind as JournalKind;
	if (journalKind !== 'group' && journalKind !== 'personal') {
		throw new Error(`journal file ${draft.journal_file_id} has invalid journal kind`);
	}

	const file: JournalFinalizationFile = {
		id: data.id,
		r2_key: data.r2_key,
		size_bytes: data.size_bytes,
		uploaded_by: data.uploaded_by,
		journal_kind: journalKind,
	};
	onFileLoaded?.(file);

	if (!file.uploaded_by) {
		throw new Error(`journal file ${draft.journal_file_id} has no quota owner`);
	}

	// A day with nothing written is simply skipped, but the draft still has to move
	// forward to today or every empty day between now and the last real entry would
	// be retried forever. The reset below is scoped to this journal file only.
	if (draft.content.trim()) {
		const current = await readJournalObject(env, file.r2_key);
		const updated = appendJournalEntry(current, draft.draft_date, draft.content);
		const encoder = new TextEncoder();
		const beforeBytes = encoder.encode(current).byteLength;
		const afterBytes = encoder.encode(updated).byteLength;
		const growthBytes = Math.max(0, afterBytes - beforeBytes);

		// Quota is charged to uploaded_by: the personal journal creator or the
		// current project owner attribution on the group journal.
		if (await wouldExceedStorageQuota(admin, env, file.uploaded_by, growthBytes)) {
			console.error(
				`[journal] journal ${draft.journal_file_id} (${file.journal_kind}) owner ${file.uploaded_by} is over quota — leaving draft queued`,
			);
			return;
		}

		const sizeBytes = await writeJournalObject(env, file.r2_key, updated);

		const { error: updateError, status: updateStatus } = await journalSchemaClient(admin)
			.from('files')
			.update({ size_bytes: sizeBytes })
			.eq('id', file.id)
			.eq('project_id', draft.project_id);
		if (updateError) throw supabaseFailure(updateError, updateStatus);
	}

	let resetQuery = journalSchemaClient(admin)
		.from('journal_drafts')
		.update({ draft_date: today, content: '', updated_by: null })
		.eq('journal_file_id', draft.journal_file_id)
		.eq('project_id', draft.project_id)
		.eq('draft_date', draft.draft_date);
	if (draft.updated_at) resetQuery = resetQuery.eq('updated_at', draft.updated_at);

	const { data: resetRows, error: resetError, status: resetStatus } = await resetQuery.select('journal_file_id');
	if (resetError) throw supabaseFailure(resetError, resetStatus);
	if (!resetRows || resetRows.length === 0) {
		console.warn(`[journal] journal ${draft.journal_file_id} changed while finalizing; leaving newer draft queued`);
	}
}
