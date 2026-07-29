import type { APIRoute } from 'astro';
import { AwsClient } from 'aws4fetch';
import { env } from 'cloudflare:workers';
import { collectDescendantFolderIds } from '../../../../../../lib/folder-tree';

export const prerender = false;

// Permanent delete — the "delete forever" action from the Trash page. Only ever
// runs on a folder already soft-deleted (delete.ts stamps its whole subtree at
// once, so every descendant is already trashed too); the cron in
// src/lib/trash.ts does the same thing on a schedule once TRASH_GRACE_DAYS has
// passed.
export const POST: APIRoute = async ({ params, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const projectId = params.id;
	const folderId = params.folderId;

	const { data: membership } = await locals.supabase
		.from('project_members')
		.select('role')
		.eq('project_id', projectId)
		.eq('user_id', locals.user.id)
		.single();

	if (!membership || !['owner', 'editor'].includes(membership.role)) {
		return new Response('Forbidden', { status: 403 });
	}

	const { data: folder, error: folderError } = await locals.supabase
		.from('folders')
		.select('id, deleted_at')
		.eq('id', folderId)
		.eq('project_id', projectId)
		.single();

	if (folderError || !folder) {
		return new Response('Folder not found', { status: 404 });
	}

	if (!folder.deleted_at) {
		return new Response('Folder is not in the trash', { status: 400 });
	}

	const folderIds = await collectDescendantFolderIds(locals.supabase, folderId as string);

	const { data: files } = await locals.supabase.from('files').select('id, r2_key').in('folder_id', folderIds);

	if (files && files.length > 0) {
		const { error: filesDeleteError } = await locals.supabase
			.from('files')
			.delete()
			.in(
				'id',
				files.map((f) => f.id),
			);

		if (filesDeleteError) {
			return new Response(`Failed to delete folder contents: ${filesDeleteError.message}`, { status: 500 });
		}
	}

	const { error } = await locals.supabase.from('folders').delete().eq('id', folderId);

	if (error) {
		return new Response(`Failed to delete folder: ${error.message}`, { status: 500 });
	}

	// Best-effort: the DB side is already committed, so a failed R2 delete here
	// just leaks storage quietly rather than undoing the folder delete.
	if (files && files.length > 0) {
		const r2 = new AwsClient({
			accessKeyId: env.R2_ACCESS_KEY_ID,
			secretAccessKey: env.R2_SECRET_ACCESS_KEY,
			service: 's3',
			region: 'auto',
		});

		await Promise.all(
			files.map((file) => {
				const objectUrl = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${file.r2_key}`;
				return r2.fetch(objectUrl, { method: 'DELETE' }).catch(() => {});
			}),
		);
	}

	return new Response(null, { status: 204 });
};
