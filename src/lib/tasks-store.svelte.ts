import { currentEpoch } from './nav-epoch';
import { sortTasks, type Task } from './task-columns';

export type { Task, TaskAssignee } from './task-columns';

// Shared across TasksSummary and TasksTable — both are independently hydrated
// `client:load` islands on the Tasks page, so the summary's counts would go stale
// the moment a task was added/edited/deleted if each kept its own copy.
export const tasksState = $state<{ tasks: Task[] }>({ tasks: [] });

let initializedEpoch = -1;

// See initTransactions in transactions-store.svelte.ts — the once-only guard has to be
// skipped during SSR or one request's tasks leak into the next request's HTML, and is
// scoped to a navigation rather than to the module on the client (see nav-epoch.ts).
export function initTasks(initial: Task[]) {
	if (initializedEpoch === currentEpoch() && !import.meta.env.SSR) return;
	tasksState.tasks = sortTasks(initial);
	initializedEpoch = currentEpoch();
}

// Every mutation re-sorts: adding a task or editing a deadline changes where the
// row belongs, and neither should need a refetch to land in the right place.
export function addTask(task: Task) {
	tasksState.tasks = sortTasks([...tasksState.tasks, task]);
}

export function updateTask(task: Task) {
	tasksState.tasks = sortTasks(tasksState.tasks.map((t) => (t.id === task.id ? task : t)));
}

export function removeTask(id: string) {
	tasksState.tasks = tasksState.tasks.filter((t) => t.id !== id);
}
