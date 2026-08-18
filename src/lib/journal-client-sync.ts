export interface JournalRealtimeRow {
	journal_file_id?: string | null;
	draft_date: string;
	content: string;
}

export function journalDraftEndpoint(projectId: string, journalFileId: string | null): string {
	return journalFileId
		? `/api/projects/${projectId}/journals/${journalFileId}/draft`
		: `/api/projects/${projectId}/journal/draft`;
}

export function journalRealtimeFilter(projectId: string, journalFileId: string | null): string {
	return journalFileId ? `journal_file_id=eq.${journalFileId}` : `project_id=eq.${projectId}`;
}

export function isRealtimeRowForJournal(row: JournalRealtimeRow, journalFileId: string | null): boolean {
	return journalFileId === null || row.journal_file_id === journalFileId;
}
