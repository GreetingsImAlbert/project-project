import test from 'node:test';
import assert from 'node:assert/strict';
import {
	canDeleteJournal,
	canEditJournal,
	canReadJournal,
	personalJournalFilename,
	type JournalAccessSubject,
	type JournalAccessTarget,
} from '../src/lib/journal-domain.ts';

const creator: JournalAccessSubject = { viewerId: 'creator', isProjectMember: true, role: 'editor' };
const owner: JournalAccessSubject = { viewerId: 'owner', isProjectMember: true, role: 'owner' };
const member: JournalAccessSubject = { viewerId: 'member', isProjectMember: true, role: 'viewer' };
const personal = (visibility: JournalAccessTarget['visibility']): JournalAccessTarget => ({
	kind: 'personal',
	creatorId: 'creator',
	visibility,
});

test('personalJournalFilename creates safe deterministic filenames', () => {
	assert.equal(personalJournalFilename('  Ada   Lovelace  '), 'JOURNAL_Ada-Lovelace.md');
	assert.equal(personalJournalFilename('张 三'), 'JOURNAL_张-三.md');
	assert.equal(personalJournalFilename('/\\\u0000'), 'JOURNAL_Member.md');
	assert.equal(personalJournalFilename('A'.repeat(400)).length, 255);
	const emojiFilename = personalJournalFilename('A'.repeat(243) + '😀');
	assert.ok(emojiFilename.length <= 255);
	assert.equal(emojiFilename.includes('\ud83d') || emojiFilename.includes('\ude00'), false);
});

test('journal read permissions hide private personal journals from owners', () => {
	assert.equal(canReadJournal(personal('private'), creator), true);
	assert.equal(canReadJournal(personal('private'), owner), false);
	assert.equal(canReadJournal(personal('members'), member), true);
	assert.equal(canReadJournal(personal('public'), { ...member, isProjectMember: false, publicJournalEnabled: false }), false);
	assert.equal(canReadJournal(personal('public'), { ...member, isProjectMember: false, publicJournalEnabled: true }), true);
});

test('journal edit and delete permissions follow journal ownership', () => {
	const group: JournalAccessTarget = { kind: 'group', creatorId: 'owner', visibility: null };
	assert.equal(canEditJournal(group, owner), true);
	assert.equal(canEditJournal(group, member), false);
	assert.equal(canDeleteJournal(group, owner), false);
	assert.equal(canEditJournal(personal('private'), creator), true);
	assert.equal(canEditJournal(personal('members'), owner), false);
	assert.equal(canDeleteJournal(personal('private'), owner), true);
	assert.equal(canDeleteJournal(personal('private'), member), false);
});
