import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProjectZip, ProjectImportError, validateP2ProjectArchive } from '../src/lib/project-import.ts';
import {
	PROJECT_PICTURE_ARCHIVE_PATH,
	sha256Hex,
	type ProjectExportManifest,
	type ProjectExportManifestV1,
	type ProjectExportManifestV2,
	type ProjectPictureDescriptor,
} from '../src/lib/project-export.ts';
import { CUSTOM_AVATAR_MAX_BYTES } from '../src/lib/avatars.ts';
import { buildProjectImportOwnershipPlan } from '../src/lib/project-import-policy.ts';
import { remapProjectImport } from '../src/lib/project-import-remap.ts';
import { zip } from '../src/lib/zip.ts';
import { createImportManifest, createJournalImportManifestV3, IMPORT_IDS } from './project-import-fixture.ts';

const encoder = new TextEncoder();
const text = (value: string) => encoder.encode(value) as Uint8Array<ArrayBuffer>;
const archive = (entries: { name: string; body?: string; bytes?: Uint8Array<ArrayBuffer> }[]) =>
	zip(entries.map((entry) => ({ name: entry.name, bytes: entry.bytes ?? text(entry.body ?? '') }))) as Uint8Array<ArrayBuffer>;

function fixtureArchive(
	manifest: ProjectExportManifest,
	fileBytes: Uint8Array<ArrayBuffer>,
	pictureBytes?: Uint8Array<ArrayBuffer>,
) {
	const legacy = JSON.stringify({ project: manifest.project.name });
	return archive([
		{ name: 'README.txt', body: `Project: ${manifest.project.name}\n` },
		{ name: 'manifest.json', body: JSON.stringify(manifest) },
		{ name: 'tasks.json', body: legacy },
		{ name: 'bom.json', body: legacy },
		{ name: 'transactions.json', body: legacy },
		{ name: 'members.json', body: legacy },
		{ name: 'files/' },
		{ name: 'files/Root/' },
		{ name: 'files/Root/Child/' },
		...(pictureBytes ? [{ name: PROJECT_PICTURE_ARCHIVE_PATH, bytes: pictureBytes }] : []),
		{ name: manifest.records.files[0].archive_path, bytes: fileBytes },
	]);
}

function journalFixtureArchive(manifest: ProjectExportManifest, fileBytes: Uint8Array<ArrayBuffer>) {
	const legacy = JSON.stringify({ project: manifest.project.name });
	return archive([
		{ name: 'README.txt', body: `Project: ${manifest.project.name}\n` },
		{ name: 'manifest.json', body: JSON.stringify(manifest) },
		{ name: 'tasks.json', body: legacy },
		{ name: 'bom.json', body: legacy },
		{ name: 'transactions.json', body: legacy },
		{ name: 'members.json', body: legacy },
		{ name: 'files/' },
		{ name: 'files/journals/' },
		{ name: 'files/Docs/' },
		{ name: manifest.records.files[0].archive_path, bytes: fileBytes },
	]);
}

function pngBytes(width = 1, height = 1): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(24) as Uint8Array<ArrayBuffer>;
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
	bytes[16] = (width >>> 24) & 0xff;
	bytes[17] = (width >>> 16) & 0xff;
	bytes[18] = (width >>> 8) & 0xff;
	bytes[19] = width & 0xff;
	bytes[20] = (height >>> 24) & 0xff;
	bytes[21] = (height >>> 16) & 0xff;
	bytes[22] = (height >>> 8) & 0xff;
	bytes[23] = height & 0xff;
	return bytes;
}

function manifestV2(
	projectPicture: ProjectPictureDescriptor | null,
): ProjectExportManifestV2 {
	const manifest = createImportManifest();
	return { ...manifest, version: 2, projectPicture };
}

test('project ZIP reader accepts the stored ZIP shape and validates CRCs', () => {
	const parsed = parseProjectZip(archive([
		{ name: 'files/' },
		{ name: 'files/readme.txt', body: 'P2' },
	]));
	assert.equal(parsed.entries.get('files/readme.txt')?.bytes.length, 2);
	assert.equal(parsed.entries.get('files/')?.isDirectory, true);
	assert.equal(parsed.totalCompressedBytes, 2);
});

test('project ZIP reader rejects traversal and duplicate entries', () => {
	assert.throws(
		() => parseProjectZip(archive([{ name: '../escape.txt', body: 'bad' }])),
		(error: unknown) => error instanceof ProjectImportError && /unsafe archive path/.test(error.message),
	);
	assert.throws(
		() => parseProjectZip(archive([{ name: 'files/a.txt', body: 'a' }, { name: 'files/a.txt', body: 'b' }])),
		(error: unknown) => error instanceof ProjectImportError && /duplicate archive entry/.test(error.message),
	);
});

test('project ZIP reader rejects corrupted local data and CRCs', () => {
	const corrupted = archive([{ name: 'files/data.bin', body: 'P2' }]);
	const dataOffset = 30 + 'files/data.bin'.length;
	corrupted[dataOffset] ^= 0xff;
	assert.throws(
		() => parseProjectZip(corrupted),
		(error: unknown) => error instanceof ProjectImportError && /CRC check failed/.test(error.message),
	);
});

test('P2 manifest validation checks the complete archive contract', async () => {
	const projectId = '11111111-1111-4111-8111-111111111111';
	const ownerId = '22222222-2222-4222-8222-222222222222';
	const manifest: ProjectExportManifestV1 = {
		format: 'p2-project-export',
		version: 1,
		exportedAt: '2026-08-10T00:00:00.000Z',
		checksumAlgorithm: 'sha256',
		project: {
			id: projectId,
			name: 'Demo project',
			description: null,
			owner_id: ownerId,
			currency: 'PHP',
			created_at: '2026-08-10T00:00:00.000Z',
			updated_at: '2026-08-10T00:00:00.000Z',
			is_public: false,
			public_files_enabled: false,
			public_tasks_enabled: false,
			public_journal_enabled: false,
			public_money_enabled: false,
		},
		people: [{ sourceUserId: ownerId, displayName: 'Owner', email: 'owner@example.test' }],
		recordCounts: {
			projectMembers: 1,
			ghostMembers: 0,
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
			projectMembers: [{ project_id: projectId, user_id: ownerId, role: 'owner', is_auditor: false, contribution_percent: null, joined_at: '2026-08-10T00:00:00.000Z' }],
			ghostMembers: [],
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
	const valid = await validateP2ProjectArchive(archive([
		{ name: 'README.txt', body: 'Project: Demo project\n' },
		{ name: 'manifest.json', body: JSON.stringify(manifest) },
		{ name: 'tasks.json', body: JSON.stringify({ project: 'Demo project' }) },
		{ name: 'bom.json', body: JSON.stringify({ project: 'Demo project' }) },
		{ name: 'transactions.json', body: JSON.stringify({ project: 'Demo project' }) },
		{ name: 'members.json', body: JSON.stringify({ project: 'Demo project' }) },
		{ name: 'files/' },
	]));
	assert.equal(valid.projectName, 'Demo project');

	const missingVisibilityFlag = JSON.parse(JSON.stringify(manifest)) as Record<string, any>;
	delete missingVisibilityFlag.project.public_tasks_enabled;
	await assert.rejects(
		() => validateP2ProjectArchive(archive([
			{ name: 'README.txt', body: 'Project: Demo project\n' },
			{ name: 'manifest.json', body: JSON.stringify(missingVisibilityFlag) },
			{ name: 'tasks.json', body: JSON.stringify({ project: 'Demo project' }) },
			{ name: 'bom.json', body: JSON.stringify({ project: 'Demo project' }) },
			{ name: 'transactions.json', body: JSON.stringify({ project: 'Demo project' }) },
			{ name: 'members.json', body: JSON.stringify({ project: 'Demo project' }) },
			{ name: 'files/' },
		])),
		(error: unknown) => error instanceof ProjectImportError && /project\.public_tasks_enabled is missing/.test(error.message),
	);

	const unsupported = { ...manifest, version: 99 };
	await assert.rejects(
		() => validateP2ProjectArchive(archive([
			{ name: 'README.txt', body: 'Project: Demo project\n' },
			{ name: 'manifest.json', body: JSON.stringify(unsupported) },
			{ name: 'tasks.json', body: JSON.stringify({ project: 'Demo project' }) },
			{ name: 'bom.json', body: JSON.stringify({ project: 'Demo project' }) },
			{ name: 'transactions.json', body: JSON.stringify({ project: 'Demo project' }) },
			{ name: 'members.json', body: JSON.stringify({ project: 'Demo project' }) },
			{ name: 'files/' },
		])),
		(error: unknown) => error instanceof ProjectImportError && /Unsupported project export format/.test(error.message),
	);
});

test('a representative exported archive validates its content before remapping', async () => {
	const content = text('data');
	const invalidManifest = createImportManifest();
	await assert.rejects(
		() => validateP2ProjectArchive(fixtureArchive(invalidManifest, content)),
		(error: unknown) => error instanceof ProjectImportError && /file checksum failed/.test(error.message),
	);

	const manifest = createImportManifest();
	manifest.records.files[0].sha256 = await sha256Hex(content);
	const validated = await validateP2ProjectArchive(fixtureArchive(manifest, content));
	assert.equal(validated.projectName, manifest.project.name);
	assert.equal(validated.fileBytes, content.length);
	assert.deepEqual([...validated.manifest.records.files].map((file) => file.archive_path), ['files/Root/Child/part.txt']);
	assert.deepEqual([...validated.archive.entries.get('files/Root/Child/part.txt')!.bytes], [...content]);
});

test('picture variants round-trip through validation and destination remapping', async () => {
	const fileBytes = text('data');

	const legacy = createImportManifest();
	legacy.records.files[0].sha256 = await sha256Hex(fileBytes);
	const legacyValidated = await validateP2ProjectArchive(fixtureArchive(legacy, fileBytes));
	assert.equal(legacyValidated.projectPictureBytes, null);
	assert.equal(
		remapProjectImport(legacy, buildProjectImportOwnershipPlan(legacy, IMPORT_IDS.importer)).payload.project.avatar,
		null,
	);

	const defaultManifest = manifestV2(null);
	defaultManifest.records.files[0].sha256 = await sha256Hex(fileBytes);
	const defaultValidated = await validateP2ProjectArchive(fixtureArchive(defaultManifest, fileBytes));
	assert.equal(defaultValidated.projectPictureBytes, null);
	assert.equal(
		remapProjectImport(defaultManifest, buildProjectImportOwnershipPlan(defaultManifest, IMPORT_IDS.importer)).payload.project.avatar,
		null,
	);

	const builtinManifest = manifestV2({ kind: 'builtin', id: 'ring' });
	builtinManifest.records.files[0].sha256 = await sha256Hex(fileBytes);
	const builtinValidated = await validateP2ProjectArchive(fixtureArchive(builtinManifest, fileBytes));
	assert.equal(builtinValidated.projectPictureBytes, null);
	assert.equal(
		remapProjectImport(builtinManifest, buildProjectImportOwnershipPlan(builtinManifest, IMPORT_IDS.importer)).payload.project.avatar,
		'ring',
	);

	const pictureBytes = pngBytes();
	const customManifest = manifestV2({
		kind: 'custom',
		archive_path: PROJECT_PICTURE_ARCHIVE_PATH,
		mime_type: 'image/png',
		content_size_bytes: pictureBytes.length,
		sha256: await sha256Hex(pictureBytes),
	});
	customManifest.records.files[0].sha256 = await sha256Hex(fileBytes);
	const customValidated = await validateP2ProjectArchive(fixtureArchive(customManifest, fileBytes, pictureBytes));
	assert.deepEqual([...customValidated.projectPictureBytes!], [...pictureBytes]);
	const remapped = remapProjectImport(customManifest, buildProjectImportOwnershipPlan(customManifest, IMPORT_IDS.importer));
	assert.equal(remapped.payload.project.avatar, remapped.projectPicturePath);
	assert.match(remapped.projectPicturePath!, /^projects\/[0-9a-f-]+\/[0-9a-f-]+\.img$/i);
	assert.notEqual(remapped.payload.project.id, customManifest.project.id);
});

test('picture validation rejects missing, corrupt, mismatched, oversized, and over-dimension images', async () => {
	const fileBytes = text('data');
	const validPicture = pngBytes();
	const customDescriptor = (bytes: Uint8Array<ArrayBuffer>): Extract<ProjectPictureDescriptor, { kind: 'custom' }> => ({
		kind: 'custom',
		archive_path: PROJECT_PICTURE_ARCHIVE_PATH,
		mime_type: 'image/png',
		content_size_bytes: bytes.length,
		sha256: '0'.repeat(64),
	});

	const missing = manifestV2(customDescriptor(validPicture));
	missing.records.files[0].sha256 = await sha256Hex(fileBytes);
	missing.projectPicture = { ...customDescriptor(validPicture), sha256: await sha256Hex(validPicture) };
	await assert.rejects(
		() => validateP2ProjectArchive(fixtureArchive(missing, fileBytes)),
		(error: unknown) => error instanceof ProjectImportError && /picture content is missing/.test(error.message),
	);

	const corruptBytes = text('not an image');
	const corrupt = manifestV2({ ...customDescriptor(corruptBytes), sha256: await sha256Hex(corruptBytes) });
	corrupt.records.files[0].sha256 = await sha256Hex(fileBytes);
	await assert.rejects(
		() => validateP2ProjectArchive(fixtureArchive(corrupt, fileBytes, corruptBytes)),
		(error: unknown) => error instanceof ProjectImportError && /signature or MIME type is invalid/.test(error.message),
	);

	const mismatched = manifestV2(customDescriptor(validPicture));
	mismatched.records.files[0].sha256 = await sha256Hex(fileBytes);
	await assert.rejects(
		() => validateP2ProjectArchive(fixtureArchive(mismatched, fileBytes, validPicture)),
		(error: unknown) => error instanceof ProjectImportError && /picture checksum failed/.test(error.message),
	);

	const oversized = manifestV2({
		...customDescriptor(validPicture),
		content_size_bytes: CUSTOM_AVATAR_MAX_BYTES + 1,
	});
	oversized.records.files[0].sha256 = await sha256Hex(fileBytes);
	await assert.rejects(
		() => validateP2ProjectArchive(fixtureArchive(oversized, fileBytes)),
		(error: unknown) => error instanceof ProjectImportError && /projectPicture size is outside the image limit/.test(error.message),
	);

	const overDimensionBytes = pngBytes(4097, 1);
	const overDimension = manifestV2({
		...customDescriptor(overDimensionBytes),
		sha256: await sha256Hex(overDimensionBytes),
	});
	overDimension.records.files[0].sha256 = await sha256Hex(fileBytes);
	await assert.rejects(
		() => validateP2ProjectArchive(fixtureArchive(overDimension, fileBytes, overDimensionBytes)),
		(error: unknown) => error instanceof ProjectImportError && /signature or MIME type is invalid/.test(error.message),
	);
});

test('legacy and built-in manifests reject unexpected picture payloads', async () => {
	const fileBytes = text('data');
	const pictureBytes = pngBytes();
	const legacy = createImportManifest();
	legacy.records.files[0].sha256 = await sha256Hex(fileBytes);
	await assert.rejects(
		() => validateP2ProjectArchive(fixtureArchive(legacy, fileBytes, pictureBytes)),
		(error: unknown) => error instanceof ProjectImportError && /unexpected project picture entry/.test(error.message),
	);

	const builtin = manifestV2({ kind: 'builtin', id: 'ring' });
	builtin.records.files[0].sha256 = await sha256Hex(fileBytes);
	await assert.rejects(
		() => validateP2ProjectArchive(fixtureArchive(builtin, fileBytes, pictureBytes)),
		(error: unknown) => error instanceof ProjectImportError && /unexpected project picture entry/.test(error.message),
	);
});

test('V3 journal manifests preserve protected folder metadata and file-keyed drafts', async () => {
	const fileBytes = text('# Group history\n');
	const manifest = createJournalImportManifestV3();
	manifest.records.files[0].content_size_bytes = fileBytes.length;
	manifest.records.files[0].sha256 = await sha256Hex(fileBytes);
	const validated = await validateP2ProjectArchive(journalFixtureArchive(manifest, fileBytes));
	assert.equal(validated.manifest.version, 3);
	assert.equal(validated.manifest.records.journalDrafts.length, 1);
	assert.equal(validated.manifest.records.folders.filter((folder) => folder.is_journals_folder).length, 1);
	const remapped = remapProjectImport(manifest, buildProjectImportOwnershipPlan(manifest, IMPORT_IDS.importer));
	assert.equal(remapped.payload.folders.filter((folder) => folder.is_journals_folder).length, 1);
	assert.equal(remapped.payload.files[0].journal_kind, 'group');
	assert.equal(remapped.payload.journalDrafts[0].journal_file_id, remapped.payload.files[0].id);

	const duplicateGroup = structuredClone(manifest);
	duplicateGroup.records.files.push({ ...duplicateGroup.records.files[0], id: IMPORT_IDS.ghost, archive_path: 'files/journals/JOURNAL-2.md' });
	duplicateGroup.recordCounts.files = 2;
	await assert.rejects(
		() => validateP2ProjectArchive(journalFixtureArchive(duplicateGroup, fileBytes)),
		(error: unknown) => error instanceof ProjectImportError && /exactly one group journal/.test(error.message),
	);

	const outsideFolder = structuredClone(manifest);
	outsideFolder.records.files[0].folder_id = IMPORT_IDS.childFolder;
	await assert.rejects(
		() => validateP2ProjectArchive(journalFixtureArchive(outsideFolder, fileBytes)),
		(error: unknown) => error instanceof ProjectImportError && /outside the protected journals folder/.test(error.message),
	);

	const unsafeFilename = structuredClone(manifest);
	unsafeFilename.records.files[0].filename = 'JOURNAL/evil.md';
	await assert.rejects(
		() => validateP2ProjectArchive(journalFixtureArchive(unsafeFilename, fileBytes)),
		(error: unknown) => error instanceof ProjectImportError && /filename .* is unsafe/.test(error.message),
	);
});

test('V3 remapping collapses duplicate active personal journals to one draft owner', () => {
	const manifest = createJournalImportManifestV3();
	const personalOne = {
		...manifest.records.files[0],
		id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
		filename: 'JOURNAL_Former-member.md',
		journal_kind: 'personal' as const,
		journal_visibility: 'members' as const,
		created_at: '2026-08-01T00:00:00.000Z',
		archive_path: 'files/journals/JOURNAL_Former-member.md',
	};
	const personalTwo = {
		...personalOne,
		id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
		filename: 'JOURNAL_Former-member-2.md',
		created_at: '2026-08-02T00:00:00.000Z',
		archive_path: 'files/journals/JOURNAL_Former-member-2.md',
	};
	manifest.records.files.push(personalOne, personalTwo);
	manifest.records.journalDrafts.push(
		{ ...manifest.records.journalDrafts[0], journal_file_id: personalOne.id },
		{ ...manifest.records.journalDrafts[0], journal_file_id: personalTwo.id },
	);
	manifest.recordCounts.files = manifest.records.files.length;
	manifest.recordCounts.journalDrafts = manifest.records.journalDrafts.length;

	const ownership = buildProjectImportOwnershipPlan(manifest, IMPORT_IDS.importer);
	const remapped = remapProjectImport(manifest, ownership, { now: '2026-08-17T00:00:00.000Z' });
	const personalFiles = remapped.payload.files.filter((file) => file.journal_kind === 'personal');
	assert.equal(personalFiles.filter((file) => file.deleted_at === null).length, 1);
	assert.equal(personalFiles.filter((file) => file.deleted_at === '2026-08-17T00:00:00.000Z').length, 1);
	assert.equal(remapped.payload.journalDrafts.filter((draft) => personalFiles.some((file) => file.id === draft.journal_file_id && file.deleted_at === null)).length, 1);
});

test('legacy V1 journal rows migrate to the protected group journal shape', () => {
	const manifest = createImportManifest();
	manifest.records.files[0].is_journal = true;
	manifest.records.files[0].folder_id = null;
	manifest.records.files[0].filename = 'Journal.md';
	manifest.records.files[0].archive_path = 'files/Journal.md';
	const ownership = buildProjectImportOwnershipPlan(manifest, IMPORT_IDS.importer);
	const remapped = remapProjectImport(manifest, ownership, { now: '2026-08-17T00:00:00.000Z' });
	const group = remapped.payload.files.find((file) => file.is_journal);
	assert.equal(group?.journal_kind, 'group');
	assert.equal(group?.filename, 'JOURNAL.md');
	assert.equal(group?.folder_id, remapped.payload.folders.find((folder) => folder.is_journals_folder)?.id);
	assert.equal(remapped.payload.journalDrafts[0].journal_file_id, group?.id);
});

test('import migrations retain atomic and idempotent database safeguards', () => {
	const atomic = readFileSync(new URL('../supabase/migrations/20260810042553_import_project_rpc.sql', import.meta.url), 'utf8');
	const visibility = readFileSync(new URL('../supabase/migrations/20260811001455_import_project_public_sections.sql', import.meta.url), 'utf8');
	const retry = readFileSync(new URL('../supabase/migrations/20260810045524_project_import_idempotency.sql', import.meta.url), 'utf8');
	const journalV3 = readFileSync(new URL('../supabase/migrations/20260817101048_project_export_journal_v3.sql', import.meta.url), 'utf8');
	const exporter = readFileSync(new URL('../src/pages/api/projects/[id]/download-all.ts', import.meta.url), 'utf8');
	const importer = readFileSync(new URL('../src/pages/api/projects/import.ts', import.meta.url), 'utf8');

	assert.match(atomic, /create or replace function public\.import_project\(/);
	assert.match(atomic, /insert into public\.projects/);
	assert.match(atomic, /v_project \? 'avatar'/);
	assert.match(atomic, /v_project->>'avatar'/);
	assert.match(atomic, /projects\/.*\[0-9a-f\]\{8\}/i);
	assert.match(atomic, /raise exception 'folder hierarchy is incomplete'/);
	assert.match(atomic, /revoke all on function public\.import_project\(uuid, jsonb\) from public/);
	assert.match(visibility, /public\.import_project\(uuid, jsonb\)/);
	assert.match(visibility, /public_tasks_enabled/);
	assert.match(visibility, /public_journal_enabled/);
	assert.match(visibility, /public_money_enabled/);
	assert.match(visibility, /jsonb_object_keys\(v_project\)\) <> 13/);
	assert.match(visibility, /v_project->>'public_tasks_enabled'.*'false'/s);
	assert.match(visibility, /public_tasks_enabled, public_journal_enabled, public_money_enabled/s);
	assert.match(retry, /primary key \(importer_id, import_token\)/);
	assert.match(retry, /on conflict \(importer_id, import_token\) do nothing/);
	assert.match(retry, /v_project_id := public\.import_project\(p_importer_id, p_payload\)/);
	assert.match(retry, /update public\.project_imports\s+set project_id = v_project_id/s);
	assert.match(retry, /revoke all on function public\.import_project_once\(uuid, text, jsonb\) from public/);
	assert.match(exporter, /projectPicture: projectPicture\.descriptor/);
	assert.match(exporter, /PROJECT_PICTURE_ARCHIVE_PATH/);
	assert.match(importer, /admin\.storage\.from\(CUSTOM_AVATAR_BUCKET\)\.upload/);
	assert.match(importer, /deleteStagedProjectPicture\(admin, failedPicture\)/);
	assert.match(importer, /const duplicatePicture = stagedPicture/);
	assert.match(importer, /admin\.rpc\('import_project_once'/);
	assert.match(journalV3, /import_project_legacy/);
	assert.match(journalV3, /journalDrafts/);
	assert.match(journalV3, /is_journals_folder/);
	assert.match(journalV3, /exactly one group journal/);
	assert.match(exporter, /ProjectExportManifestV3/);
	assert.match(exporter, /journalDrafts/);
	assert.match(importer, /manifest\.version !== 1/);
});
