import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(path: string): string {
	return readFileSync(new URL(path, import.meta.url), 'utf8');
}

test('generic content reads and writes apply journal ownership capabilities', () => {
	const content = source('../src/pages/api/files/[fileId]/content.ts');
	assert.match(content, /canEditJournal/);
	assert.match(content, /journal_kind, journal_visibility, deleted_at/);
	assert.match(content, /const mayEdit =/);
	assert.ok(content.indexOf('if (!mayEdit)') < content.indexOf("method: 'HEAD'"));
});

test('generic file mutations reject journal rename move copy and public sharing', () => {
	for (const route of ['rename', 'move', 'copy', 'visibility']) {
		const api = source(`../src/pages/api/files/[fileId]/${route}.ts`);
		assert.match(api, /is_journal/, route);
		assert.match(api, /if \(file\.is_journal\)/, route);
	}
	const remove = source('../src/pages/api/files/[fileId]/delete.ts');
	assert.match(remove, /canDeleteJournal/);
	assert.match(remove, /journal_file_id/);
});

test('Files UI uses per-journal capabilities and protects the journals folder', () => {
	const page = source('../src/pages/projects/[id]/files.astro');
	const browser = source('../src/components/FileBrowser.svelte');
	const list = source('../src/components/FileList.svelte');
	assert.match(page, /journal_kind, journal_visibility/);
	assert.match(page, /canReadJournal/);
	assert.match(page, /canEditJournal/);
	assert.match(page, /canDeleteJournal/);
	assert.match(list, /file\.is_journal \? file\.canDelete === true : canEdit/);
	assert.doesNotMatch(list, /canEdit && !file\.is_journal/);
	assert.match(browser, /currentFolderProtected/);
	assert.match(browser, /!folder\.is_journals_folder/);
});

test('folder APIs and database RPC reject protected journal trees', () => {
	for (const route of ['rename', 'delete', 'restore', 'purge']) {
		const api = source(`../src/pages/api/projects/[id]/folders/[folderId]/${route}.ts`);
		assert.match(api, /is_journals_folder/, route);
	}
	const migration = source('../supabase/migrations/20260817092407_journal_overhaul.sql');
	assert.match(migration, /folders_journals_folder_root_check/);
	assert.match(migration, /folders_one_journals_folder_per_project/);
	assert.match(migration, /create or replace function public\.soft_delete_folder_tree/);
	assert.match(migration, /the journals folder and journal files are protected/);
	assert.match(migration, /and not is_journal/);
});

test('Trash restores and purges only authorized personal journals', () => {
	const trash = source('../src/pages/api/projects/[id]/trash.ts');
	const restore = source('../src/pages/api/files/[fileId]/restore.ts');
	const purge = source('../src/pages/api/files/[fileId]/purge.ts');
	assert.match(trash, /canRestore/);
	assert.match(trash, /canPurge/);
	assert.match(restore, /canDeleteJournal/);
	assert.match(restore, /ensureJournalsFolder/);
	assert.match(restore, /ensureJournalDraft/);
	assert.match(restore, /active personal journal already exists/);
	assert.match(purge, /canDeleteJournal/);
	assert.match(purge, /journal_kind/);
});

test('generic previews and downloads use journal visibility instead of files is_public', () => {
	const access = source('../src/lib/file-access.ts');
	for (const route of ['content', 'raw', 'download-url']) {
		assert.match(source(`../src/pages/api/files/[fileId]/${route}.ts`), /getReadableFile/, route);
	}
	assert.match(access, /public_journal_enabled/);
	assert.match(access, /canReadJournal/);
	assert.match(access, /file\.is_journal\s*\?/);
	assert.match(access, /: file\.is_public && project\?\.public_files_enabled/);
});

test('journal overhaul migration scopes drafts and RLS by journal file', () => {
	const migration = source('../supabase/migrations/20260817092407_journal_overhaul.sql');
	assert.match(migration, /journal_file_id uuid/);
	assert.match(migration, /primary key \(journal_file_id\)/);
	assert.match(migration, /journal_drafts_file_project_fkey/);
	assert.match(migration, /members can view permitted journal drafts/);
	assert.match(migration, /protect_journal_file_update/);
	assert.match(migration, /journal_kind = 'group'/);
});
