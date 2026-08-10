import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectExportManifestV1 } from '../src/lib/project-export.ts';
import { ProjectImportError } from '../src/lib/project-import.ts';
import { buildProjectImportOwnershipPlan } from '../src/lib/project-import-policy.ts';

const projectId = '11111111-1111-4111-8111-111111111111';
const ownerId = '22222222-2222-4222-8222-222222222222';
const teammateId = '33333333-3333-4333-8333-333333333333';
const uploaderId = '44444444-4444-4444-8444-444444444444';
const existingGhostId = '55555555-5555-4555-8555-555555555555';
const importerId = '66666666-6666-4666-8666-666666666666';

function manifest(): ProjectExportManifestV1 {
	return {
		format: 'p2-project-export',
		version: 1,
		exportedAt: '2026-08-10T00:00:00.000Z',
		checksumAlgorithm: 'sha256',
		project: {
			id: projectId,
			name: 'Imported project',
			description: 'Keep this description',
			owner_id: ownerId,
			currency: 'USD',
			created_at: '2026-08-01T00:00:00.000Z',
			updated_at: '2026-08-02T00:00:00.000Z',
			is_public: true,
			public_files_enabled: true,
		},
		people: [
			{ sourceUserId: ownerId, displayName: 'Former owner', email: 'owner@example.test' },
			{ sourceUserId: teammateId, displayName: 'Former teammate', email: 'teammate@example.test' },
			{ sourceUserId: uploaderId, displayName: 'Former uploader', email: null },
		],
		recordCounts: {
			projectMembers: 2,
			ghostMembers: 1,
			folders: 0,
			files: 0,
			bomItems: 0,
			transactions: 0,
			tasks: 0,
			taskAssignees: 0,
			taskCategories: 0,
			taskCategoryPositions: 0,
			journalDrafts: 0,
		},
		records: {
			projectMembers: [
				{ project_id: projectId, user_id: ownerId, role: 'owner', is_auditor: false, contribution_percent: 60, joined_at: '2026-08-01T00:00:00.000Z' },
				{ project_id: projectId, user_id: teammateId, role: 'editor', is_auditor: true, contribution_percent: 40, joined_at: '2026-08-02T00:00:00.000Z' },
			],
			ghostMembers: [{ id: existingGhostId, project_id: projectId, display_name: 'Legacy ghost', note: 'Keep note', contribution_percent: 10, is_deleted_account: true, created_at: '2026-08-03T00:00:00.000Z' }],
			folders: [],
			files: [],
			bomItems: [],
			transactions: [],
			tasks: [],
			taskAssignees: [],
			taskCategories: [],
			taskCategoryPositions: [],
			journalDraft: null,
		},
	};
}

test('ownership policy makes the importer sole private owner and ghosts every source identity', () => {
	const plan = buildProjectImportOwnershipPlan(manifest(), importerId);

	assert.deepEqual(plan.project, {
		name: 'Imported project',
		description: 'Keep this description',
		currency: 'USD',
		owner_id: importerId,
		is_public: false,
		public_files_enabled: false,
	});
	assert.deepEqual(plan.realMember, {
		user_id: importerId,
		role: 'owner',
		is_auditor: false,
		contribution_percent: null,
	});
	assert.equal(plan.ghostMembers.length, 4);
	assert.equal(plan.personGhostKeys[ownerId], `person:${ownerId}`);
	assert.equal(plan.personGhostKeys[uploaderId], `person:${uploaderId}`);
	assert.equal(plan.exportedGhostKeys[existingGhostId], `ghost:${existingGhostId}`);
	assert.equal(plan.ghostMembers.find((ghost) => ghost.sourceUserId === teammateId)?.contribution_percent, 40);
	assert.equal(plan.ghostMembers.find((ghost) => ghost.sourceGhostId === existingGhostId)?.is_deleted_account, true);
	assert.equal(plan.realMember.user_id === ownerId, false);
});

test('ownership policy rejects an invalid importer identity', () => {
	assert.throws(
		() => buildProjectImportOwnershipPlan(manifest(), 'not-a-uuid'),
		(error: unknown) => error instanceof ProjectImportError && /importer identity is invalid/.test(error.message),
	);
});
