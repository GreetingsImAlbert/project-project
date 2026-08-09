import { currentEpoch } from './nav-epoch';
import { sortTasks, type Task, type TaskCategoryPosition, type TaskSortMode } from './task-columns';
import { notifyTasksChanged } from './tasks-changed';

export type { Task, TaskAssignee, TaskCategoryPosition } from './task-columns';

// Shared across TasksTable and TasksSummary so the summary follows edits without
// carrying a second full copy of the task payload.
export const tasksState = $state<{
	tasks: Task[];
	categoryPositions: TaskCategoryPosition[];
	sortMode: TaskSortMode;
	initialized: boolean;
	epoch: number;
}>({ tasks: [], categoryPositions: [], sortMode: 'deadline', initialized: false, epoch: -1 });

let initializedEpoch = -1;

// See initTransactions in transactions-store.svelte.ts — the once-only guard has to be
// skipped during SSR or one request's tasks leak into the next request's HTML, and is
// scoped to a navigation rather than to the module on the client (see nav-epoch.ts).
export function initTasks(initial: Task[], initialCategoryPositions: TaskCategoryPosition[] = []) {
	if (initializedEpoch === currentEpoch() && !import.meta.env.SSR) return;
	tasksState.categoryPositions = [...initialCategoryPositions];
	tasksState.tasks = sortTasks(initial, tasksState.categoryPositions, tasksState.sortMode);
	tasksState.initialized = true;
	tasksState.epoch = currentEpoch();
	initializedEpoch = currentEpoch();
}

export function isTasksInitializedForCurrentEpoch(): boolean {
	return tasksState.initialized && tasksState.epoch === currentEpoch();
}

// Every mutation re-sorts: adding a task or editing a deadline changes where the
// row belongs, and neither should need a refetch to land in the right place.
// The sidebar's counters listen for the change event each one fires.
export function addTask(task: Task) {
	tasksState.tasks = sortTasks([...tasksState.tasks, task], tasksState.categoryPositions, tasksState.sortMode);
	notifyTasksChanged();
}

export function updateTask(task: Task) {
	tasksState.tasks = sortTasks(
		tasksState.tasks.map((t) => (t.id === task.id ? task : t)),
		tasksState.categoryPositions,
		tasksState.sortMode,
	);
	notifyTasksChanged();
}

// The segmented control in the next checklist step can switch the order without
// refetching. Keeping the mode here also makes add/edit responses use the same rule.
export function setTaskSortMode(mode: TaskSortMode) {
	tasksState.sortMode = mode;
	tasksState.tasks = sortTasks(tasksState.tasks, tasksState.categoryPositions, mode);
}

export function removeTask(id: string) {
	tasksState.tasks = tasksState.tasks.filter((t) => t.id !== id);
	notifyTasksChanged();
}
