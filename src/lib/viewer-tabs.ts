export interface ViewerTab {
	id: string;
	filename: string;
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
