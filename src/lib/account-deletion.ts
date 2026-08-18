import { AwsClient } from 'aws4fetch';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database.types';
import { CUSTOM_AVATAR_BUCKET, isStoredAvatarPath } from './avatars';

// How long a requested deletion sits reversible before the cron makes it
// permanent, and how long an orphaned file lingers after that for another
// member to save a copy. The scheduled worker uses these constants to drive
// both grace periods.
export const PENDING_DELETION_GRACE_DAYS = 10;
export const FILE_GRACE_DAYS = 30;

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

// Moves every transaction a member is a party to onto a fresh ghost member per
// project, so the money history survives the profile row that's about to be
// hard-deleted. Has to run before deleteUser, not after — transactions.member_id
// has no cascade specifically so this gets the chance to run first, matching
// the database foreign-key behavior.
async function repointTransactionsToGhosts(
	admin: SupabaseClient<Database>,
	userId: string,
	displayName: string,
): Promise<void> {
	const { data: partyRows } = await admin
		.from('transactions')
		.select('project_id')
		.or(`member_id.eq.${userId},related_member_id.eq.${userId}`);

	const projectIds = [...new Set((partyRows ?? []).map((row) => row.project_id))];

	for (const projectId of projectIds) {
		const { data: membership } = await admin
			.from('project_members')
			.select('contribution_percent')
			.eq('project_id', projectId)
			.eq('user_id', userId)
			.maybeSingle();

		const { data: ghost, error: ghostError } = await admin
			.from('ghost_members')
			.insert({
				project_id: projectId,
				display_name: displayName,
				note: 'Stands in for a member whose P2 account was deleted; preserves their transaction history.',
				contribution_percent: membership?.contribution_percent ?? null,
				is_deleted_account: true,
			})
			.select('id')
			.single();

		if (ghostError || !ghost) {
			throw new Error(
				`Failed to create stand-in ghost member for project ${projectId}: ${ghostError?.message ?? 'unknown error'}`,
			);
		}

		await admin
			.from('transactions')
			.update({ member_id: null, ghost_member_id: ghost.id })
			.eq('project_id', projectId)
			.eq('member_id', userId);

		await admin
			.from('transactions')
			.update({ related_member_id: null, related_ghost_member_id: ghost.id })
			.eq('project_id', projectId)
			.eq('related_member_id', userId);
	}
}

interface OwnedJournalRow {
	id: string;
	project_id: string;
	journal_kind: string | null;
}

// A hard-deleted account must never leave the required group journal attributed
// to a missing profile. Transfer normally does this in one SQL transaction, but
// this guard makes the deletion path safe even if an older transfer or a manual
// repair left the attribution behind.
async function reattributeGroupJournals(
	admin: SupabaseClient<Database>,
	userId: string,
): Promise<void> {
	const { data: rows, error } = await admin
		.from('files')
		.select('id, project_id, journal_kind')
		.eq('uploaded_by', userId)
		.eq('is_journal', true)
		.eq('journal_kind', 'group');
	if (error) throw new Error(`Failed to inspect group journal ownership: ${error.message}`);

	const groupJournals = (rows ?? []) as OwnedJournalRow[];
	if (groupJournals.length === 0) return;

	const projectIds = [...new Set(groupJournals.map((row) => row.project_id))];
	const { data: projects, error: projectError } = await admin
		.from('projects')
		.select('id, owner_id')
		.in('id', projectIds);
	if (projectError) throw new Error(`Failed to inspect group journal owners: ${projectError.message}`);

	const ownerByProject = new Map((projects ?? []).map((project) => [project.id, project.owner_id]));
	for (const journal of groupJournals) {
		const ownerId = ownerByProject.get(journal.project_id);
		if (!ownerId || ownerId === userId) {
			throw new Error(`Cannot delete ${userId}: group journal ${journal.id} has no successor owner`);
		}

		const { error: updateError } = await admin
			.from('files')
			.update({ uploaded_by: ownerId, uploader_deleted_at: null })
			.eq('id', journal.id)
			.eq('project_id', journal.project_id)
			.eq('uploaded_by', userId)
			.eq('journal_kind', 'group');
		if (updateError) {
			throw new Error(`Failed to reattribute group journal ${journal.id}: ${updateError.message}`);
		}
	}
}

// Personal journal Markdown remains recoverable through the orphan-file grace
// period, but its live draft and journal visibility must stop with the account.
async function freezePersonalJournals(
	admin: SupabaseClient<Database>,
	userId: string,
	deletedAt: string,
): Promise<void> {
	const { data: rows, error } = await admin
		.from('files')
		.select('id')
		.eq('uploaded_by', userId)
		.eq('is_journal', true)
		.eq('journal_kind', 'personal');
	if (error) throw new Error(`Failed to inspect personal journals: ${error.message}`);

	const journalIds = (rows ?? []).map((row) => row.id);
	if (journalIds.length === 0) return;

	const { error: draftError } = await admin
		.from('journal_drafts')
		.delete()
		.in('journal_file_id', journalIds);
	if (draftError) throw new Error(`Failed to remove deleted-account journal drafts: ${draftError.message}`);

	const { error: freezeError } = await admin
		.from('files')
		.update({ deleted_at: deletedAt, uploader_deleted_at: deletedAt })
		.in('id', journalIds)
		.eq('uploaded_by', userId)
		.eq('journal_kind', 'personal');
	if (freezeError) throw new Error(`Failed to freeze personal journals: ${freezeError.message}`);
}

// The actual, permanent removal — only ever called by the cron once a pending
// deletion has cleared its grace period (see purgeExpiredPendingDeletions).
export async function hardDeleteAccount(admin: SupabaseClient<Database>, userId: string): Promise<void> {
	const { count: ownedCount } = await admin
		.from('projects')
		.select('id', { count: 'exact', head: true })
		.eq('owner_id', userId);

	if (ownedCount && ownedCount > 0) {
		// Shouldn't happen — the request endpoint already blocks this — but a project
		// could in principle be transferred back to this member during the grace
		// window. Leave the row pending rather than fail loudly; it'll be picked up
		// again once ownership moves on.
		console.error(`[account-deletion] ${userId} still owns ${ownedCount} project(s) — leaving pending`);
		return;
	}

	const { data: profile } = await admin.from('profiles').select('display_name, avatar').eq('id', userId).single();
	const displayName = profile?.display_name ?? 'Former member';

	if (profile?.avatar && isStoredAvatarPath(profile.avatar)) {
		const { error: avatarError } = await admin.storage.from(CUSTOM_AVATAR_BUCKET).remove([profile.avatar]);
		if (avatarError) {
			throw new Error(`Failed to remove profile picture for ${userId}: ${avatarError.message}`);
		}
	}

	await repointTransactionsToGhosts(admin, userId, displayName);

	const deletedAt = new Date().toISOString();
	await reattributeGroupJournals(admin, userId);
	await freezePersonalJournals(admin, userId, deletedAt);

	// Stamped before the delete, not after — uploaded_by is about to go null via
	// its own on-delete-set-null FK, so this is the last moment anything ties these
	// rows back to this particular account.
	const { error: orphanStampError } = await admin
		.from('files')
		.update({ uploader_deleted_at: deletedAt })
		.eq('uploaded_by', userId);
	if (orphanStampError) throw new Error(`Failed to mark uploaded files for ${userId}: ${orphanStampError.message}`);

	// Same idea for task appointments: user_id is about to go null (on delete set
	// null, not cascade, matching the database foreign-key behavior), so the row
	// survives with a name snapshot instead of the appointment just disappearing.
	await admin.from('task_assignees').update({ deleted_display_name: `${displayName} [deleted]` }).eq('user_id', userId);

	const { error } = await admin.auth.admin.deleteUser(userId);
	if (error) {
		throw new Error(`Failed to hard-delete account ${userId}: ${error.message}`);
	}
}

// Runs daily from the Cron Trigger (src/worker.ts). Finds every profile whose
// grace period has lapsed and hard-deletes it — one failure shouldn't stop the
// rest, so each is caught and logged rather than propagated.
export async function purgeExpiredPendingDeletions(admin: SupabaseClient<Database>): Promise<void> {
	const cutoff = new Date(Date.now() - PENDING_DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000).toISOString();

	const { data: dueProfiles, error } = await admin
		.from('profiles')
		.select('id')
		.not('pending_deletion_at', 'is', null)
		.lte('pending_deletion_at', cutoff);

	if (error) {
		console.error(`[account-deletion] failed to read pending deletions: ${error.message}`);
		return;
	}

	for (const profile of dueProfiles ?? []) {
		try {
			await hardDeleteAccount(admin, profile.id);
		} catch (err) {
			console.error(`[account-deletion] failed to delete ${profile.id}: ${(err as Error).message}`);
		}
	}
}

// Runs daily alongside purgeExpiredPendingDeletions. Deletes orphaned normal files
// and frozen personal journals after FILE_GRACE_DAYS. The required group journal
// is deliberately excluded even if a stale uploader-deletion marker exists.
export async function purgeOrphanedFiles(admin: SupabaseClient<Database>, env: Env): Promise<void> {
	const cutoff = new Date(Date.now() - FILE_GRACE_DAYS * 24 * 60 * 60 * 1000).toISOString();

	const { data: dueFiles, error } = await admin
		.from('files')
		.select('id, r2_key, is_journal, journal_kind')
		.not('uploader_deleted_at', 'is', null)
		.or('is_journal.eq.false,journal_kind.eq.personal')
		.lte('uploader_deleted_at', cutoff);

	if (error) {
		console.error(`[account-deletion] failed to read orphaned files: ${error.message}`);
		return;
	}

	if (!dueFiles || dueFiles.length === 0) return;

	const r2 = r2Client(env);
	await Promise.all(dueFiles.map((file) => r2.fetch(objectUrlFor(env, file.r2_key), { method: 'DELETE' }).catch(() => {})));

	const { error: deleteError } = await admin
		.from('files')
		.delete()
		.in(
			'id',
			dueFiles.map((f) => f.id),
		);

	if (deleteError) {
		console.error(`[account-deletion] failed to delete purged file rows: ${deleteError.message}`);
	}
}
