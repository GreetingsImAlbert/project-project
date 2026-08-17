import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(path: string): string {
	return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const collection = source('../src/pages/api/projects/[id]/journals/index.ts');
const draft = source('../src/pages/api/projects/[id]/journals/[journalFileId]/draft.ts');
const visibility = source('../src/pages/api/projects/[id]/journals/[journalFileId]/visibility.ts');
const remove = source('../src/pages/api/projects/[id]/journals/[journalFileId]/delete.ts');

test('personal journal creation is membership-scoped, idempotent, and restore-aware', () => {
	assert.match(collection, /if \(!locals\.user\)/);
	assert.match(collection, /membership\.role !== 'owner'.*membership\.role !== 'editor'/s);
	assert.match(collection, /\.eq\('journal_kind', 'personal'\)/);
	assert.match(collection, /\.eq\('uploaded_by', locals\.user\.id\)/);
	assert.match(collection, /restoreRequired: true/);
	assert.match(collection, /body\.restore !== true/);
	assert.match(collection, /createPersonalJournal/);
	assert.match(collection, /ensureJournalDraft/);
});

test('journal draft saves are scoped to both project and journal file', () => {
	assert.match(draft, /params\.journalFileId/);
	assert.match(draft, /\.eq\('id', journalFileId\)/);
	assert.match(draft, /\.eq\('project_id', projectId\)/);
	assert.match(draft, /canEditJournal/);
	assert.match(draft, /journal_file_id: journalFileId/);
	assert.match(draft, /onConflict: 'journal_file_id'/);
	assert.match(draft, /MAX_DRAFT_CHARS/);
});

test('personal visibility changes remain creator-only and allowlisted', () => {
	assert.match(visibility, /canChangeJournalVisibility/);
	assert.match(visibility, /visibility !== 'private'/);
	assert.match(visibility, /visibility !== 'members'/);
	assert.match(visibility, /visibility !== 'public'/);
	assert.match(visibility, /\.eq\('journal_kind', 'personal'\)/);
	assert.match(visibility, /\.eq\('uploaded_by', locals\.user\.id\)/);
});

test('personal delete uses narrow metadata and removes the live draft', () => {
	assert.match(remove, /canDeleteJournal/);
	assert.match(remove, /select\('uploaded_by, journal_kind, deleted_at'\)/);
	assert.doesNotMatch(remove, /select\([^)]*(?:r2_key|content)/);
	assert.match(remove, /\.eq\('journal_kind', 'personal'\)/);
	assert.match(remove, /from\('journal_drafts'\)\.delete\(\)\.eq\('journal_file_id', journalFileId\)/);
	assert.match(remove, /status: 204/);
});

test('journal item routes hide IDs from non-members and forbid unauthorized members', () => {
	for (const route of [draft, visibility, remove]) {
		assert.match(route, /if \(!membership\) return new Response\('Journal not found', \{ status: 404 \}\)/);
		assert.match(route, /new Response\('Forbidden', \{ status: 403 \}\)/);
	}
});
