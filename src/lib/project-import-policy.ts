import type { ProjectExportManifestV1 } from './project-export';
import { ProjectImportError } from './project-import';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ProjectImportProjectDraft {
	name: string;
	description: string | null;
	currency: 'PHP' | 'USD';
	owner_id: string;
	is_public: false;
	public_files_enabled: false;
}

export interface ProjectImportMemberDraft {
	user_id: string;
	role: 'owner';
	is_auditor: false;
	contribution_percent: null;
}

export interface ProjectImportGhostDraft {
	/** Internal source key. Task 8 replaces it with a fresh database ID. */
	sourceKey: string;
	sourceUserId: string | null;
	sourceGhostId: string | null;
	display_name: string;
	note: string | null;
	contribution_percent: number | null;
	is_deleted_account: boolean;
	created_at: string | null;
}

export interface ProjectImportOwnershipPlan {
	project: ProjectImportProjectDraft;
	realMember: ProjectImportMemberDraft;
	ghostMembers: ProjectImportGhostDraft[];
	/** Every exported profile identity resolves to a ghost source key. */
	personGhostKeys: Record<string, string>;
	/** Every exported ghost-member identity resolves to a ghost source key. */
	exportedGhostKeys: Record<string, string>;
}

function assertImporterId(importerId: string): void {
	if (!UUID_PATTERN.test(importerId)) throw new ProjectImportError('The authenticated importer identity is invalid.');
}

/**
 * Applies the import boundary before any database or storage work occurs.
 *
 * Exported profile IDs are source identities only. They never become project
 * members in the destination; all of them are represented by ghost drafts so
 * file uploaders, transaction parties, assignees, and journal editors can be
 * remapped later without linking to an account from the archive.
 */
export function buildProjectImportOwnershipPlan(
	manifest: ProjectExportManifestV1,
	importerId: string,
): ProjectImportOwnershipPlan {
	assertImporterId(importerId);
	if (manifest.project.currency !== 'PHP' && manifest.project.currency !== 'USD') {
		throw new ProjectImportError('The imported project currency is invalid.');
	}

	const memberByUserId = new Map(manifest.records.projectMembers.map((member) => [member.user_id, member]));
	const personGhostKeys: Record<string, string> = {};
	const exportedGhostKeys: Record<string, string> = {};
	const ghostMembers: ProjectImportGhostDraft[] = [];

	for (const person of manifest.people) {
		const sourceKey = `person:${person.sourceUserId}`;
		personGhostKeys[person.sourceUserId] = sourceKey;
		const member = memberByUserId.get(person.sourceUserId);
		ghostMembers.push({
			sourceKey,
			sourceUserId: person.sourceUserId,
			sourceGhostId: null,
			display_name: person.displayName,
			note: null,
			contribution_percent: member?.contribution_percent ?? null,
			is_deleted_account: false,
			created_at: member?.joined_at ?? null,
		});
	}

	for (const ghost of manifest.records.ghostMembers) {
		const sourceKey = `ghost:${ghost.id}`;
		exportedGhostKeys[ghost.id] = sourceKey;
		ghostMembers.push({
			sourceKey,
			sourceUserId: null,
			sourceGhostId: ghost.id,
			display_name: ghost.display_name,
			note: ghost.note,
			contribution_percent: ghost.contribution_percent,
			is_deleted_account: ghost.is_deleted_account,
			created_at: ghost.created_at,
		});
	}

	return {
		project: {
			name: manifest.project.name,
			description: manifest.project.description,
			currency: manifest.project.currency,
			owner_id: importerId,
			is_public: false,
			public_files_enabled: false,
		},
		realMember: {
			user_id: importerId,
			role: 'owner',
			is_auditor: false,
			contribution_percent: null,
		},
		ghostMembers,
		personGhostKeys,
		exportedGhostKeys,
	};
}
