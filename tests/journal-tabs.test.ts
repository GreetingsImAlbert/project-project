import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const page = readFileSync(new URL('../src/pages/projects/[id]/journal.astro', import.meta.url), 'utf8');
const component = readFileSync(new URL('../src/components/JournalPage.svelte', import.meta.url), 'utf8');

test('member journal loading uses visible collections and valid deep links', () => {
	assert.match(page, /loadProjectJournals\(admin, env, project\.id, user\.id\)/);
	assert.match(page, /Astro\.url\.searchParams\.get\('journal'\)/);
	assert.match(page, /a\.kind === 'group' \? -1 : 1/);
	assert.match(page, /journal\.creatorId === user\.id/);
	assert.match(page, /journal_visibility', 'private'/);
});

test('journal tabs are accessible, scrollable, and keyboard navigable', () => {
	assert.match(component, /role="tablist"/);
	assert.match(component, /role="tab"/);
	assert.match(component, /aria-selected=/);
	assert.match(component, /aria-controls=/);
	assert.match(component, /role="tabpanel"/);
	assert.match(component, /ArrowRight/);
	assert.match(component, /ArrowLeft/);
	assert.match(component, /event\.key === 'Home'/);
	assert.match(component, /event\.key === 'End'/);
	assert.match(component, /overflow-x: auto/);
});

test('each journal keeps isolated draft, history, and save state', () => {
	assert.match(component, /Record<string, JournalState>/);
	assert.match(component, /await flushPendingSave\(activeJournalId\)/);
	assert.match(component, /activeJournalId = journalFileId/);
	assert.match(component, /state\.entries = \[\{ date: state\.draftDate/);
	assert.match(component, /state\.lastSavedContent/);
});

test('journal actions follow capabilities without exposing private content management', () => {
	assert.match(component, /Create my journal/);
	assert.match(component, /active\.canChangeVisibility/);
	assert.match(component, /Project Settings → Journal visibility/);
	assert.match(component, /active\.canDelete/);
	assert.match(component, /Only \$\{active\.creatorName/);
	assert.match(component, /their contents remain private/);
	assert.match(page, /select\('id, filename, uploaded_by, profiles!files_uploaded_by_fkey\(display_name\)'\)/);
	assert.doesNotMatch(page.slice(page.indexOf("if (userRole === 'owner')")), /r2_key|journal_drafts|content/);
});
