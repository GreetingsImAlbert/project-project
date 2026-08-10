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
import { createImportManifest, IMPORT_IDS } from './project-import-fixture.ts';

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

test('import migrations retain atomic and idempotent database safeguards', () => {
	const atomic = readFileSync(new URL('../supabase/migrations/20260810042553_import_project_rpc.sql', import.meta.url), 'utf8');
	const retry = readFileSync(new URL('../supabase/migrations/20260810045524_project_import_idempotency.sql', import.meta.url), 'utf8');
	const exporter = readFileSync(new URL('../src/pages/api/projects/[id]/download-all.ts', import.meta.url), 'utf8');
	const importer = readFileSync(new URL('../src/pages/api/projects/import.ts', import.meta.url), 'utf8');

	assert.match(atomic, /create or replace function public\.import_project\(/);
	assert.match(atomic, /insert into public\.projects/);
	assert.match(atomic, /v_project \? 'avatar'/);
	assert.match(atomic, /v_project->>'avatar'/);
	assert.match(atomic, /projects\/.*\[0-9a-f\]\{8\}/i);
	assert.match(atomic, /raise exception 'folder hierarchy is incomplete'/);
	assert.match(atomic, /revoke all on function public\.import_project\(uuid, jsonb\) from public/);
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
});
