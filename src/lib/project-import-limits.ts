import { MAX_GHOST_NAME, MAX_GHOST_NOTE, MAX_GHOSTS_PER_PROJECT } from './ghost-members';
import { ProjectImportError, PROJECT_IMPORT_LIMITS } from './project-import';
import type { ProjectExportManifest } from './project-export';
import type { ProjectImportOwnershipPlan } from './project-import-policy';

export interface ProjectImportLimitSummary {
	fileBytes: number;
	ghostMemberCount: number;
	recordCount: number;
}

/**
 * Checks destination-side limits that are not archive-format limits. The user
 * count is intentionally not consumed: importing adds one project and ghosts,
 * never an auth/profile row. Storage quota is checked separately against the
 * importer because it requires the environment-aware Supabase RPC.
 */
export function validateProjectImportLimits(
	manifest: ProjectExportManifest,
	ownership: ProjectImportOwnershipPlan,
): ProjectImportLimitSummary {
	const ghostMemberCount = ownership.ghostMembers.length;
	if (ghostMemberCount > MAX_GHOSTS_PER_PROJECT) {
		throw new ProjectImportError(`This project would need ${ghostMemberCount} ghost members; the limit is ${MAX_GHOSTS_PER_PROJECT}.`);
	}
	for (const ghost of ownership.ghostMembers) {
		if (!ghost.display_name || ghost.display_name.length > MAX_GHOST_NAME) {
			throw new ProjectImportError(`A ghost member name must be between 1 and ${MAX_GHOST_NAME} characters.`);
		}
		if (ghost.note && ghost.note.length > MAX_GHOST_NOTE) {
			throw new ProjectImportError(`A ghost member note cannot exceed ${MAX_GHOST_NOTE} characters.`);
		}
	}

	const recordCount = Object.values(manifest.recordCounts).reduce((total, count) => total + count, 0);
	if (recordCount > PROJECT_IMPORT_LIMITS.maxRecordRows * 10) {
		throw new ProjectImportError('The project contains too many records to import safely.');
	}

	return {
		fileBytes: manifest.records.files.reduce((total, file) => total + file.content_size_bytes, 0),
		ghostMemberCount,
		recordCount,
	};
}
