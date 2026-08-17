import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
	isRealtimeRowForJournal,
	journalDraftEndpoint,
	journalRealtimeFilter,
} from '../src/lib/journal-client-sync.ts';

test('journal client routes saves and realtime subscriptions by journal file ID', () => {
	assert.equal(journalDraftEndpoint('project-1', 'journal-2'), '/api/projects/project-1/journals/journal-2/draft');
	assert.equal(journalRealtimeFilter('project-1', 'journal-2'), 'journal_file_id=eq.journal-2');
	assert.equal(isRealtimeRowForJournal({ journal_file_id: 'journal-2', draft_date: '2026-08-17', content: 'A' }, 'journal-2'), true);
	assert.equal(isRealtimeRowForJournal({ journal_file_id: 'journal-3', draft_date: '2026-08-17', content: 'B' }, 'journal-2'), false);
});

test('legacy journal client behavior remains available until the tab migration', () => {
	assert.equal(journalDraftEndpoint('project-1', null), '/api/projects/project-1/journal/draft');
	assert.equal(journalRealtimeFilter('project-1', null), 'project_id=eq.project-1');
	assert.equal(isRealtimeRowForJournal({ draft_date: '2026-08-17', content: 'Legacy' }, null), true);
});

test('JournalPage flushes pending saves and rejects late cross-journal events', () => {
	const component = readFileSync(new URL('../src/components/JournalPage.svelte', import.meta.url), 'utf8');
	assert.match(component, /export async function flushPendingSave/);
	assert.match(component, /saveSequences\.get\(journalFileId\) !== sequence/);
	assert.match(component, /activeJournalId !== journalFileId/);
	assert.match(component, /recentOwnWrites/);
	assert.match(component, /isRealtimeRowForJournal/);
	assert.match(component, /removeChannel\(channel\)/);
	assert.match(component, /keepalive/);
});

test('realtime token endpoint permits every current project member', () => {
	const endpoint = readFileSync(new URL('../src/pages/api/projects/[id]/journal/realtime-token.ts', import.meta.url), 'utf8');
	assert.match(endpoint, /if \(!membership\)/);
	assert.doesNotMatch(endpoint, /\['owner', 'editor'\]/);
});
