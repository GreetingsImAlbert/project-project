import { AwsClient } from 'aws4fetch';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database.types';

// How long a soft-deleted row sits recoverable in the Trash page before the daily
// cron makes it permanent. The scheduled worker enforces this retention period.
export const TRASH_GRACE_DAYS = 10;

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

// Runs daily from the Cron Trigger (src/worker.ts), alongside the account-deletion
// jobs. Each table is independent and caught on its own, same reasoning as
// purgeExpiredPendingDeletions: one failure shouldn't stop the rest.
export async function purgeTrash(admin: SupabaseClient<Database>, env: Env): Promise<void> {
	const cutoff = new Date(Date.now() - TRASH_GRACE_DAYS * 24 * 60 * 60 * 1000).toISOString();

	await Promise.all([
		purgeFiles(admin, env, cutoff),
		purgeSimpleTable(admin, 'folders', cutoff),
		purgeSimpleTable(admin, 'tasks', cutoff),
		purgeSimpleTable(admin, 'bom_items', cutoff),
		purgeSimpleTable(admin, 'transactions', cutoff),
	]);
}

// Files need their R2 object cleaned up first — everything else is a plain row
// delete, since the FKs on each table already say what should cascade.
async function purgeFiles(admin: SupabaseClient<Database>, env: Env, cutoff: string): Promise<void> {
	const { data: dueFiles, error } = await admin
		.from('files')
		.select('id, r2_key')
		.not('deleted_at', 'is', null)
		.lte('deleted_at', cutoff);

	if (error) {
		console.error(`[trash] failed to read trashed files: ${error.message}`);
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
		console.error(`[trash] failed to delete purged file rows: ${deleteError.message}`);
	}
}

async function purgeSimpleTable(
	admin: SupabaseClient<Database>,
	table: 'folders' | 'tasks' | 'bom_items' | 'transactions',
	cutoff: string,
): Promise<void> {
	const { error } = await admin.from(table).delete().not('deleted_at', 'is', null).lte('deleted_at', cutoff);

	if (error) {
		console.error(`[trash] failed to purge ${table}: ${error.message}`);
	}
}
