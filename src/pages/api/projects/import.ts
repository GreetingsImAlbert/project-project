import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { ProjectImportError, PROJECT_IMPORT_LIMITS, validateP2ProjectArchive } from '../../../lib/project-import';
import { sha256Hex } from '../../../lib/project-export';
import { getSupabaseAdmin } from '../../../lib/supabase/admin';
import { wouldExceedStorageQuota } from '../../../lib/r2-quota';
import { validateProjectImportLimits } from '../../../lib/project-import-limits';
import { buildProjectImportOwnershipPlan } from '../../../lib/project-import-policy';
import { remapProjectImport } from '../../../lib/project-import-remap';
import { deleteStagedProjectFiles, stageProjectImportFiles, type StagedProjectFiles } from '../../../lib/project-import-stage';
import type { Json } from '../../../lib/supabase/database.types';

export const prerender = false;

const IMPORT_TOKEN_PATTERN = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9a-f]{64})$/i;

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
	const rawImportToken = formData.get('importToken');
	if (rawImportToken !== null && typeof rawImportToken !== 'string') return json({ message: 'The project import token is invalid.' }, 400);
	const requestedImportToken = typeof rawImportToken === 'string' ? rawImportToken.trim().toLowerCase() : null;
	if (requestedImportToken && !IMPORT_TOKEN_PATTERN.test(requestedImportToken)) return json({ message: 'The project import token is invalid.' }, 400);

	let staged: StagedProjectFiles | null = null;
	try {
		const archiveBytes = new Uint8Array(await value.arrayBuffer());
		const validated = await validateP2ProjectArchive(archiveBytes);
		const ownership = buildProjectImportOwnershipPlan(validated.manifest, locals.user.id);
		const limits = validateProjectImportLimits(validated.manifest, ownership);
		const importToken = requestedImportToken || await sha256Hex(archiveBytes);
		const admin = getSupabaseAdmin(env);
		const { data: previousImport, error: statusError } = await admin
			.from('project_imports')
			.select('project_id')
			.eq('importer_id', locals.user.id)
			.eq('import_token', importToken)
			.maybeSingle();
		if (statusError) {
			console.error('[project-import] Idempotency lookup failed', statusError);
			return json({ message: 'Could not check the project import status.' }, 500);
		}
		if (previousImport) {
			if (!previousImport.project_id) return json({ message: 'This project import is already in progress.' }, 409);
			return json({
				projectId: previousImport.project_id,
				name: validated.projectName,
				fileBytes: limits.fileBytes,
				message: 'Project was already imported.',
			}, 200);
		}
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

		const { data: projectId, error } = await admin.rpc('import_project_once', {
			p_importer_id: locals.user.id,
			p_import_token: importToken,
			p_payload: remapped.payload as unknown as Json,
		});
		if (error || typeof projectId !== 'string') {
			const failedStage = staged;
			staged = null;
			if (failedStage && env.R2_BUCKET) await deleteStagedProjectFiles(env.R2_BUCKET, failedStage);
			console.error('[project-import] Database import failed', error);
			return json({ message: 'Could not create the imported project.' }, 500);
		}

		const duplicateProject = projectId !== remapped.payload.project.id;
		if (duplicateProject) {
			const duplicateStage = staged;
			staged = null;
			if (duplicateStage && env.R2_BUCKET) await deleteStagedProjectFiles(env.R2_BUCKET, duplicateStage);
			return json({
				projectId,
				name: validated.projectName,
				fileBytes: limits.fileBytes,
				message: 'Project was already imported.',
			}, 200);
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
