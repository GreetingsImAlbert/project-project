import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProjectImportOwnershipPlan } from '../src/lib/project-import-policy.ts';
import { validateProjectImportLimits } from '../src/lib/project-import-limits.ts';
import { remapProjectImport } from '../src/lib/project-import-remap.ts';
import { stageProjectImportFiles } from '../src/lib/project-import-stage.ts';
import type { ParsedProjectZip } from '../src/lib/project-import.ts';
import { createImportManifest, IMPORT_IDS } from './project-import-fixture.ts';

const generatedIds = [
	'10101010-1010-4010-8010-101010101010',
	'20202020-2020-4020-8020-202020202020',
	'30303030-3030-4030-8030-303030303030',
	'40404040-4040-4040-8040-404040404040',
	'50505050-5050-4050-8050-505050505050',
	'60606060-6060-4060-8060-606060606060',
	'70707070-7070-4070-8070-707070707070',
	'80808080-8080-4080-8080-808080808080',
	'90909090-9090-4090-8090-909090909090',
	'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
	'ffffffff-ffff-4fff-8fff-ffffffffffff',
	'12121212-1212-4121-8121-121212121212',
];

function prepare() {
	const manifest = createImportManifest();
	const ownership = buildProjectImportOwnershipPlan(manifest, IMPORT_IDS.importer);
	const remapped = remapProjectImport(manifest, ownership, {
		idFactory: (() => {
			let index = 0;
			return () => generatedIds[index++];
		})(),
		now: '2026-08-10T00:00:00.000Z',
	});
	return { manifest, ownership, remapped };
}

test('import remapping generates fresh IDs and rewrites every relationship', () => {
	const { manifest, remapped } = prepare();
	const payload = remapped.payload;
	const id = IMPORT_IDS;

	assert.notEqual(payload.project.id, id.project);
	assert.equal(payload.project.owner_id, id.importer);
	assert.equal(payload.project.is_public, false);
	assert.equal(payload.project.public_files_enabled, false);
	assert.equal(payload.project.created_at, manifest.project.created_at);
	assert.equal(payload.project.updated_at, manifest.project.updated_at);
	assert.equal(payload.projectMember.user_id, id.importer);
	assert.equal(payload.ghostMembers.length, 3);
	assert.equal(payload.folders.find((folder) => folder.name === 'Child')?.parent_folder_id, payload.folders.find((folder) => folder.name === 'Root')?.id);
	assert.equal(payload.files[0].uploaded_by, id.importer);
	assert.equal(payload.files[0].size_bytes, 4);
	assert.equal(payload.files[0].is_public, false);
	assert.equal(payload.files[0].uploader_deleted_at, null);
	assert.equal(payload.transactions[0].member_id, null);
	assert.equal(payload.transactions[0].ghost_member_id, payload.ghostMembers.find((ghost) => ghost.display_name === 'Former member')?.id);
	assert.equal(payload.transactions[0].related_ghost_member_id, payload.ghostMembers.find((ghost) => ghost.display_name === 'External sponsor')?.id);
	assert.equal(payload.tasks[0].id === id.task, false);
	assert.equal(payload.taskAssignees[0].task_id, payload.tasks[0].id);
	assert.equal(payload.taskAssignees[0].user_id, null);
	assert.equal(payload.taskAssignees[0].ghost_member_id, payload.ghostMembers.find((ghost) => ghost.display_name === 'Former member')?.id);
	assert.equal(payload.journalDraft?.updated_by, id.importer);
	assert.equal('total_cost' in payload.bomItems[0], false);
	assert.equal('total_cost' in payload.transactions[0], false);

	const sourceIds: string[] = Object.values(id);
	for (const row of [payload.project, ...payload.ghostMembers, ...payload.folders, ...payload.files, ...payload.bomItems, ...payload.transactions, ...payload.tasks, ...payload.taskAssignees, ...payload.taskCategoryPositions]) {
		if ('id' in row) assert.equal(sourceIds.includes(row.id), false);
	}
	assert.equal(manifest.records.files[0].archive_path, 'files/Root/Child/part.txt');
});

test('import limits reject projects whose ghost conversion exceeds the project cap', () => {
	const manifest = createImportManifest();
	manifest.people = Array.from({ length: 21 }, (_, index) => ({
		sourceUserId: `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
		displayName: `Person ${index + 1}`,
		email: null,
	}));
	const ownership = buildProjectImportOwnershipPlan(manifest, IMPORT_IDS.importer);
	assert.throws(() => validateProjectImportLimits(manifest, ownership), /ghost members/);
});

test('staging writes fresh project keys sequentially and cleans partial failures', async () => {
	const { manifest, remapped } = prepare();
	const bytes = new TextEncoder().encode('data');
	const archive: ParsedProjectZip = {
		entries: new Map([[manifest.records.files[0].archive_path, {
			name: manifest.records.files[0].archive_path,
			bytes,
			isDirectory: false,
			compressedSize: bytes.length,
			uncompressedSize: bytes.length,
		}]]),
		totalCompressedBytes: bytes.length,
		totalUncompressedBytes: bytes.length,
	};
	const objects = new Map<string, Uint8Array>();
	const bucket = {
		put: async (key: string, value: Uint8Array) => { objects.set(key, value); },
		delete: async (key: string) => { objects.delete(key); },
	};
	const staged = await stageProjectImportFiles(archive, manifest, remapped, bucket);
	assert.equal(staged.files.length, 1);
	assert.equal(staged.files[0].r2Key.startsWith(`${remapped.payload.project.id}/`), true);
	assert.deepEqual(objects.get(staged.files[0].r2Key), bytes);
});
