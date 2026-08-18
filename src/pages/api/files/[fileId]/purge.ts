import type { APIRoute } from 'astro';
import { AwsClient } from 'aws4fetch';
import { env } from 'cloudflare:workers';
import { errorResponse } from '../../../../lib/error-report';
import { getSupabaseAdmin } from '../../../../lib/supabase/admin';
import { canDeleteJournal, journalSchemaClient, type JournalKind, type JournalVisibility } from '../../../../lib/journal';

export const prerender = false;

// Permanent delete — the "delete forever" action from the Trash page. Only ever
// runs on something already soft-deleted; the cron in src/lib/trash.ts does the
// same thing on a schedule once TRASH_GRACE_DAYS has passed.
export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const fileId = params.fileId;
	const admin = getSupabaseAdmin(env);

	const { data: file, error: fileError } = await journalSchemaClient(admin)
		.from('files')
		.select('project_id, r2_key, uploaded_by, uploader_deleted_at, is_journal, journal_kind, journal_visibility, deleted_at')
		.eq('id', fileId)
		.single();

	if (fileError || !file) {
		return new Response('File not found', { status: 404 });
	}

	if (!file.deleted_at) {
		return new Response('File is not in the trash', { status: 400 });
	}

	const { data: membership } = await locals.supabase
		.from('project_members')
		.select('role')
		.eq('project_id', file.project_id)
		.eq('user_id', locals.user.id)
		.maybeSingle();

	if (!membership) return new Response('File not found', { status: 404 });
	if (file.is_journal && file.journal_kind === 'personal' && file.uploader_deleted_at) {
		return new Response('This journal is frozen for orphan cleanup', { status: 410 });
	}
	const mayPurge = file.is_journal
		? canDeleteJournal({
			kind: file.journal_kind as JournalKind,
			creatorId: file.uploaded_by,
			visibility: file.journal_visibility as JournalVisibility | null,
		}, { viewerId: locals.user.id, isProjectMember: true, role: membership.role })
		: ['owner', 'editor'].includes(membership.role);
	if (!mayPurge) {
		return new Response('Forbidden', { status: 403 });
	}

	const { error } = await journalSchemaClient(admin).from('files').delete().eq('id', fileId);

	if (error) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to delete file: ${error.message}`,
			action: 'Failed to delete file.',
			context: { fileId: fileId ?? null, projectId: file.project_id },
		});
	}

	// Real signed R2 request (not the Workers binding, which resolves to a
	// separate local-only store under plain `wrangler dev`) — mirrors copy.ts/confirm.ts.
	const r2 = new AwsClient({
		accessKeyId: env.R2_ACCESS_KEY_ID,
		secretAccessKey: env.R2_SECRET_ACCESS_KEY,
		service: 's3',
		region: 'auto',
	});
	const objectUrl = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${file.r2_key}`;
	await r2.fetch(objectUrl, { method: 'DELETE' }).catch(() => {});

	return new Response(null, { status: 204 });
};
