import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { ProjectImportError, PROJECT_IMPORT_LIMITS, validateP2ProjectArchive } from '../../../lib/project-import';
import { getSupabaseAdmin } from '../../../lib/supabase/admin';
import { wouldExceedStorageQuota } from '../../../lib/r2-quota';
import { validateProjectImportLimits } from '../../../lib/project-import-limits';
import { buildProjectImportOwnershipPlan } from '../../../lib/project-import-policy';
import { remapProjectImport } from '../../../lib/project-import-remap';
import { deleteStagedProjectFiles, stageProjectImportFiles, type StagedProjectFiles } from '../../../lib/project-import-stage';
import type { Json } from '../../../lib/supabase/database.types';

export const prerender = false;

function json(body: Record<string, unknown>, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
		},
	});
}

export const POST: APIRoute = async ({ request, locals }) => {
	if (!locals.user) return json({ message: 'Unauthorized' }, 401);

	let formData: FormData;
	try {
		formData = await request.formData();
	} catch {
		return json({ message: 'Upload a project ZIP file.' }, 400);
	}

	const value = formData.get('file');
	if (!(value instanceof File)) return json({ message: 'Choose a project ZIP file.' }, 400);
	if (value.size === 0) return json({ message: 'The project ZIP file is empty.' }, 400);
	if (value.size > PROJECT_IMPORT_LIMITS.maxArchiveBytes) return json({ message: 'The project ZIP file is too large.' }, 413);

	let staged: StagedProjectFiles | null = null;
	try {
		const archiveBytes = new Uint8Array(await value.arrayBuffer());
		const validated = await validateP2ProjectArchive(archiveBytes);
		const ownership = buildProjectImportOwnershipPlan(validated.manifest, locals.user.id);
		const limits = validateProjectImportLimits(validated.manifest, ownership);
		const admin = getSupabaseAdmin(env);
		if (limits.fileBytes > 0) {
			if (await wouldExceedStorageQuota(admin, env, locals.user.id, limits.fileBytes)) {
				return json({ message: 'Storage quota exceeded or unavailable.' }, 507);
			}
		}
		const remapped = remapProjectImport(validated.manifest, ownership);
		if (remapped.payload.files.length > 0) {
			if (!env.R2_BUCKET) return json({ message: 'File storage is unavailable.' }, 503);
			staged = await stageProjectImportFiles(validated.archive, validated.manifest, remapped, env.R2_BUCKET);
		}

		const { data: projectId, error } = await admin.rpc('import_project', {
			p_importer_id: locals.user.id,
			p_payload: remapped.payload as unknown as Json,
		});
		if (error || typeof projectId !== 'string') {
			const failedStage = staged;
			staged = null;
			if (failedStage && env.R2_BUCKET) await deleteStagedProjectFiles(env.R2_BUCKET, failedStage);
			console.error('[project-import] Database import failed', error);
			return json({ message: 'Could not create the imported project.' }, 500);
		}

		staged = null;
		return json({
			projectId,
			name: validated.projectName,
			fileBytes: limits.fileBytes,
			message: 'Project imported successfully.',
		}, 201);
	} catch (error) {
		if (staged && env.R2_BUCKET) await deleteStagedProjectFiles(env.R2_BUCKET, staged);
		if (error instanceof ProjectImportError) return json({ message: error.message }, 400);
		console.error('[project-import] Import failed', error);
		return json({ message: 'Could not import the project ZIP file.' }, 500);
	}
};
