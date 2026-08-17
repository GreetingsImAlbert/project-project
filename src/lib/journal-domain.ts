import { MAX_FILENAME_LENGTH } from './file-kind';

export type JournalKind = 'group' | 'personal';
export type JournalVisibility = 'private' | 'members' | 'public';

export interface JournalAccessSubject {
	viewerId: string | null;
	isProjectMember: boolean;
	role: string | null;
	publicJournalEnabled?: boolean;
}

export interface JournalAccessTarget {
	kind: JournalKind;
	creatorId: string | null;
	visibility: JournalVisibility | null;
}

function truncateWithoutSplittingUnicode(value: string, maxLength: number): string {
	let result = '';
	for (const character of value) {
		if (result.length + character.length > maxLength) break;
		result += character;
	}
	return result;
}

export function personalJournalFilename(displayName: string): string {
	const suffixLength = 'JOURNAL_'.length + '.md'.length;
	const maxSlugLength = MAX_FILENAME_LENGTH - suffixLength;
	const safeName = displayName
		.trim()
		.replace(/\s+/gu, '-')
		.replace(/[\\/\u0000-\u001f\u007f-\u009f]/gu, '');
	const slug = truncateWithoutSplittingUnicode(safeName, maxSlugLength) || 'Member';

	return `JOURNAL_${slug}.md`;
}

export function canReadJournal(journal: JournalAccessTarget, subject: JournalAccessSubject): boolean {
	if (!subject.isProjectMember) {
		return subject.publicJournalEnabled === true
			&& (journal.kind === 'group' || journal.visibility === 'public');
	}
	if (journal.kind === 'group' || journal.creatorId === subject.viewerId) return true;
	return journal.visibility === 'members' || journal.visibility === 'public';
}

export function canEditJournal(journal: JournalAccessTarget, subject: JournalAccessSubject): boolean {
	if (!subject.isProjectMember || !subject.viewerId) return false;
	if (journal.kind === 'group') return subject.role === 'owner' || subject.role === 'editor';
	return journal.creatorId === subject.viewerId;
}

export function canDeleteJournal(journal: JournalAccessTarget, subject: JournalAccessSubject): boolean {
	return subject.isProjectMember
		&& journal.kind === 'personal'
		&& (journal.creatorId === subject.viewerId || subject.role === 'owner');
}

export function canChangeJournalVisibility(journal: JournalAccessTarget, subject: JournalAccessSubject): boolean {
	return subject.isProjectMember
		&& journal.kind === 'personal'
		&& journal.creatorId === subject.viewerId;
}
