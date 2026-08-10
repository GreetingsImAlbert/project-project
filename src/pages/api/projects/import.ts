import type { APIRoute } from 'astro';
import { ProjectImportError, PROJECT_IMPORT_LIMITS, validateP2ProjectArchive } from '../../../lib/project-import';
import { buildProjectImportOwnershipPlan } from '../../../lib/project-import-policy';

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

	try {
		const archiveBytes = new Uint8Array(await value.arrayBuffer());
		const validated = await validateP2ProjectArchive(archiveBytes);
		const ownership = buildProjectImportOwnershipPlan(validated.manifest, locals.user.id);
		// Database/R2 creation remains in later import tasks. Returning 202 here keeps
		// this endpoint validation-only while proving the ownership/privacy policy is
		// applied before any destination records could be created.
		return json({
			format: validated.manifest.format,
			version: validated.manifest.version,
			name: validated.projectName,
			fileBytes: validated.fileBytes,
			private: ownership.project.is_public === false && ownership.project.public_files_enabled === false,
			realMemberCount: 1,
			ghostMemberCount: ownership.ghostMembers.length,
			message: 'Project archive validated and ready for import.',
		}, 202);
	} catch (error) {
		if (error instanceof ProjectImportError) return json({ message: error.message }, 400);
		console.error('[project-import] Archive validation failed', error);
		return json({ message: 'Could not validate the project ZIP file.' }, 500);
	}
};
