import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProjectZip, ProjectImportError, validateP2ProjectArchive } from '../src/lib/project-import.ts';
import { sha256Hex, type ProjectExportManifestV1 } from '../src/lib/project-export.ts';
import { zip } from '../src/lib/zip.ts';
import { createImportManifest } from './project-import-fixture.ts';

const encoder = new TextEncoder();
const text = (value: string) => encoder.encode(value) as Uint8Array<ArrayBuffer>;
const archive = (entries: { name: string; body?: string; bytes?: Uint8Array<ArrayBuffer> }[]) =>
	zip(entries.map((entry) => ({ name: entry.name, bytes: entry.bytes ?? text(entry.body ?? '') }))) as Uint8Array<ArrayBuffer>;

function fixtureArchive(manifest: ProjectExportManifestV1, fileBytes: Uint8Array<ArrayBuffer>) {
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
		{ name: manifest.records.files[0].archive_path, bytes: fileBytes },
	]);
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

test('import migrations retain atomic and idempotent database safeguards', () => {
	const atomic = readFileSync(new URL('../supabase/migrations/20260810042553_import_project_rpc.sql', import.meta.url), 'utf8');
	const retry = readFileSync(new URL('../supabase/migrations/20260810045524_project_import_idempotency.sql', import.meta.url), 'utf8');

	assert.match(atomic, /create or replace function public\.import_project\(/);
	assert.match(atomic, /insert into public\.projects/);
	assert.match(atomic, /raise exception 'folder hierarchy is incomplete'/);
	assert.match(atomic, /revoke all on function public\.import_project\(uuid, jsonb\) from public/);
	assert.match(retry, /primary key \(importer_id, import_token\)/);
	assert.match(retry, /on conflict \(importer_id, import_token\) do nothing/);
	assert.match(retry, /v_project_id := public\.import_project\(p_importer_id, p_payload\)/);
	assert.match(retry, /update public\.project_imports\s+set project_id = v_project_id/s);
	assert.match(retry, /revoke all on function public\.import_project_once\(uuid, text, jsonb\) from public/);
});
