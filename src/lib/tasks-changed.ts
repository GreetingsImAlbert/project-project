// A tiny event bus between the tasks page and the sidebar.
//
// The sidebar's per-project counters come from /api/navigation, which it fetches
// once on mount. Task mutations happen in a different island, so after any add,
// edit, or delete lands in the tasks store, this event tells the sidebar to
// re-fetch rather than wait for the next navigation (or a poller).
export const TASKS_CHANGED_EVENT = 'p2:tasks-changed';

export function notifyTasksChanged(): void {
	if (typeof window === 'undefined') return;
	window.dispatchEvent(new CustomEvent(TASKS_CHANGED_EVENT));
}
