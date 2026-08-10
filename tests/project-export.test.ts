import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProjectArchiveLayout, safeArchiveName, sha256Hex } from '../src/lib/project-export.ts';

test('project archive layout preserves empty folders and produces unique safe paths', () => {
	const layout = buildProjectArchiveLayout(
		[
			{ id: 'folder-a', name: 'Design', parent_folder_id: null, created_at: '2026-01-01' },
			{ id: 'folder-b', name: 'Design', parent_folder_id: null, created_at: '2026-01-02' },
			{ id: 'folder-c', name: 'CAD:*', parent_folder_id: 'folder-a', created_at: '2026-01-03' },
		],
		[
			{ id: 'file-a', filename: 'part?.step', folder_id: 'folder-c', created_at: '2026-01-01' },
			{ id: 'file-b', filename: 'part*.step', folder_id: 'folder-c', created_at: '2026-01-02' },
			{ id: 'file-c', filename: 'old.txt', folder_id: null, deleted_at: '2026-01-03' },
		],
	);

	assert.equal(layout.folderArchivePaths.get('folder-a'), 'files/Design/');
	assert.equal(layout.folderArchivePaths.get('folder-b'), 'files/Design (2)/');
	assert.equal(layout.folderArchivePaths.get('folder-c'), 'files/Design/CAD--/');
	assert.equal(layout.filePaths.get('file-a'), 'files/Design/CAD--/part-.step');
	assert.equal(layout.filePaths.get('file-b'), 'files/Design/CAD--/part- (2).step');
	assert.equal(layout.filePaths.get('file-c'), 'trash/files/old.txt');
	assert.ok(layout.directoryEntries.includes('files/Design (2)/'));
	assert.ok(layout.directoryEntries.includes('trash/files/'));
});

test('project archive layout rejects broken folder relationships', () => {
	assert.throws(
		() => buildProjectArchiveLayout([{ id: 'child', name: 'Child', parent_folder_id: 'missing' }], []),
		/missing parent/,
	);
	assert.throws(
		() => buildProjectArchiveLayout([
			{ id: 'a', name: 'A', parent_folder_id: 'b' },
			{ id: 'b', name: 'B', parent_folder_id: 'a' },
		], []),
		/contains a cycle/,
	);
});

test('project export filename sanitizing and checksums are stable', async () => {
	assert.equal(safeArchiveName('  CAD:<draft>  '), 'CAD--draft-');
	assert.equal(
		await sha256Hex(new TextEncoder().encode('P2')),
		'acbbb742c7524cecdec7557d60e4a19af062346309ce5731c88485c7daf48982',
	);
});
