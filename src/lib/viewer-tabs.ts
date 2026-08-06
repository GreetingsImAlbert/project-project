export interface ViewerTab {
	id: string;
	filename: string;
}

export interface ViewerState {
	activeFileId: string | null;
	width: number;
}

export const VIEWER_COMMAND_EVENT = 'p2:viewer-command';
export const VIEWER_STATE_EVENT = 'p2:viewer-state';
export const VIEWER_SAVED_EVENT = 'p2:viewer-saved';

export type ViewerCommand =
	| { type: 'open'; file: ViewerTab; edit?: boolean }
	| { type: 'close-file'; fileId: string }
	| { type: 'rename-file'; fileId: string; filename: string }
	| { type: 'request-state' };

function dispatchViewerCommand(command: ViewerCommand) {
	if (typeof window === 'undefined') return;
	window.dispatchEvent(new CustomEvent<ViewerCommand>(VIEWER_COMMAND_EVENT, { detail: command }));
}

export function openViewerFile(file: ViewerTab, edit = false) {
	dispatchViewerCommand({ type: 'open', file, edit });
}

export function closeViewerFile(fileId: string) {
	dispatchViewerCommand({ type: 'close-file', fileId });
}

export function renameViewerFile(fileId: string, filename: string) {
	dispatchViewerCommand({ type: 'rename-file', fileId, filename });
}

export function requestViewerState() {
	dispatchViewerCommand({ type: 'request-state' });
}

export function loadActiveViewerFile(storageKey: string, tabs: ViewerTab[]): string | null {
	if (typeof localStorage === 'undefined') return null;
	try {
		const fileId = localStorage.getItem(storageKey);
		return fileId && tabs.some((tab) => tab.id === fileId) ? fileId : null;
	} catch {
		return null;
	}
}

export function loadViewerTabs(storageKey: string): ViewerTab[] {
	if (typeof localStorage === 'undefined') return [];

	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
		if (!Array.isArray(parsed)) return [];

		const seen = new Set<string>();
		return parsed.filter((entry): entry is ViewerTab => {
			if (!entry || typeof entry !== 'object') return false;
			const candidate = entry as { id?: unknown; filename?: unknown };
			if (typeof candidate.id !== 'string' || candidate.id === '') return false;
			if (typeof candidate.filename !== 'string' || candidate.filename === '') return false;
			if (seen.has(candidate.id)) return false;
			seen.add(candidate.id);
			return true;
		});
	} catch {
		return [];
	}
}

export function saveViewerTabs(storageKey: string, tabs: ViewerTab[]) {
	try {
		localStorage.setItem(storageKey, JSON.stringify(tabs));
	} catch {
		// Storage can be disabled or full; the open tabs still work for this session.
	}
}
