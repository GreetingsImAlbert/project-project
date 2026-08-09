import { currentEpoch } from './nav-epoch';
import { sortTasks, type Task, type TaskCategoryPosition, type TaskSortMode } from './task-columns';
import { notifyTasksChanged } from './tasks-changed';

export type { Task, TaskAssignee, TaskCategoryPosition } from './task-columns';

export type TaskReorderError =
	| { scope: 'task'; taskId: string; message: string }
	| { scope: 'category'; category: string | null; message: string }
	| { scope: 'categories'; message: string };

export type TaskReorderResult = { ok: true } | { ok: false; error: string };

interface TaskOrderResponse {
	ok: true;
	type: 'category' | 'move';
	taskId?: string;
	orders: { category: string | null; taskIds: string[] }[];
}

interface CategoryOrderResponse {
	ok: true;
	categoryNames: (string | null)[];
	categoryPositions: { id: string | null; categoryName: string | null; priorityPosition: number }[];
}

// Shared across TasksTable and TasksSummary so the summary follows edits without
// carrying a second full copy of the task payload.
export const tasksState = $state<{
	tasks: Task[];
	categoryPositions: TaskCategoryPosition[];
	sortMode: TaskSortMode;
	initialized: boolean;
	epoch: number;
}>({ tasks: [], categoryPositions: [], sortMode: 'deadline', initialized: false, epoch: -1 });

// Reorders are deliberately separate from tasksState: a failed drag must restore the
// data snapshot while still leaving a small, visible explanation beside the affected
// row or category. The next reorder clears the previous message.
export const taskReorderState = $state<{ pending: boolean; error: TaskReorderError | null }>({ pending: false, error: null });

interface TaskStateSnapshot {
	tasks: Task[];
	categoryPositions: TaskCategoryPosition[];
}

let initializedEpoch = -1;

// See initTransactions in transactions-store.svelte.ts — the once-only guard has to be
// skipped during SSR or one request's tasks leak into the next request's HTML, and is
// scoped to a navigation rather than to the module on the client (see nav-epoch.ts).
export function initTasks(initial: Task[], initialCategoryPositions: TaskCategoryPosition[] = []) {
	if (initializedEpoch === currentEpoch() && !import.meta.env.SSR) return;
	tasksState.categoryPositions = [...initialCategoryPositions];
	tasksState.tasks = sortTasks(initial, tasksState.categoryPositions, tasksState.sortMode);
	taskReorderState.pending = false;
	taskReorderState.error = null;
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

function normalizedCategory(category: string | null): string | null {
	return category?.trim() || null;
}

function categoryKey(category: string | null): string {
	return category === null ? '\u0000' : category;
}

function snapshot(): TaskStateSnapshot {
	return {
		tasks: tasksState.tasks.map((task) => ({
			...task,
			assignees: task.assignees.map((assignee) => ({ ...assignee })),
		})),
		categoryPositions: tasksState.categoryPositions.map((position) => ({ ...position })),
	};
}

function restore(snapshotToRestore: TaskStateSnapshot) {
	tasksState.tasks = snapshotToRestore.tasks;
	tasksState.categoryPositions = snapshotToRestore.categoryPositions;
	notifyTasksChanged();
}

function beginReorder(): boolean {
	if (taskReorderState.pending) return false;
	taskReorderState.pending = true;
	taskReorderState.error = null;
	return true;
}

function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

async function postReorder<T>(url: string, payload: unknown, fallback: string): Promise<T> {
	let response: Response;
	try {
		response = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload),
		});
	} catch {
		throw new Error(fallback);
	}

	if (!response.ok) {
		const message = (await response.text()).trim();
		throw new Error(message || fallback);
	}

	try {
		return (await response.json()) as T;
	} catch {
		throw new Error('Server returned an invalid reorder response');
	}
}

function isTaskOrderResponse(value: unknown): value is TaskOrderResponse {
	if (!value || typeof value !== 'object') return false;
	const response = value as Partial<TaskOrderResponse>;
	if (response.ok !== true || (response.type !== 'category' && response.type !== 'move') || !Array.isArray(response.orders)) return false;
	return response.orders.every(
		(order) =>
			!!order &&
			typeof order === 'object' &&
			((order.category === null) || typeof order.category === 'string') &&
			Array.isArray(order.taskIds) &&
			order.taskIds.every((id) => typeof id === 'string'),
	);
}

function isCategoryOrderResponse(value: unknown): value is CategoryOrderResponse {
	if (!value || typeof value !== 'object') return false;
	const response = value as Partial<CategoryOrderResponse>;
	return (
		response.ok === true &&
		Array.isArray(response.categoryNames) &&
		response.categoryNames.every((category) => category === null || typeof category === 'string') &&
		Array.isArray(response.categoryPositions) &&
		response.categoryPositions.every(
			(position) =>
				!!position &&
				(position.id === null || typeof position.id === 'string') &&
				(position.categoryName === null || typeof position.categoryName === 'string') &&
				typeof position.priorityPosition === 'number',
		)
	);
}

function applyTaskOrders(orders: TaskOrderResponse['orders']) {
	const current = new Map(tasksState.tasks.map((task) => [task.id, task]));
	const updates = new Map<string, { category: string | null; priority_position: number }>();
	const seen = new Set<string>();

	for (const order of orders) {
		for (let index = 0; index < order.taskIds.length; index += 1) {
			const id = order.taskIds[index];
			if (!current.has(id) || seen.has(id)) throw new Error('Server returned an invalid task order');
			seen.add(id);
			updates.set(id, { category: normalizedCategory(order.category), priority_position: index });
		}
	}

	tasksState.tasks = tasksState.tasks.map((task) => {
		const update = updates.get(task.id);
		return update ? { ...task, ...update } : task;
	});
	tasksState.tasks = sortTasks(tasksState.tasks, tasksState.categoryPositions, tasksState.sortMode);
	notifyTasksChanged();
}

function applyOptimisticTaskOrder(category: string | null, taskIds: string[]) {
	const normalized = normalizedCategory(category);
	const current = new Map(tasksState.tasks.map((task) => [task.id, task]));
	const updates = new Map<string, { category: string | null; priority_position: number }>();
	for (let index = 0; index < taskIds.length; index += 1) {
		const task = current.get(taskIds[index]);
		if (!task || task.status === 'done' || normalizedCategory(task.category) !== normalized) {
			throw new Error('Invalid task order');
		}
		if (updates.has(task.id)) throw new Error('Invalid task order');
		updates.set(task.id, { category: normalized, priority_position: index });
	}
	tasksState.tasks = tasksState.tasks.map((task) => {
		const update = updates.get(task.id);
		return update ? { ...task, ...update } : task;
	});
	tasksState.tasks = sortTasks(tasksState.tasks, tasksState.categoryPositions, tasksState.sortMode);
	notifyTasksChanged();
}

function applyOptimisticTaskMove(
	taskId: string,
	sourceCategory: string | null,
	destinationCategory: string | null,
	sourceTaskIds: string[],
	destinationTaskIds: string[],
) {
	const normalizedSource = normalizedCategory(sourceCategory);
	const normalizedDestination = normalizedCategory(destinationCategory);
	const current = new Map(tasksState.tasks.map((task) => [task.id, task]));
	const moved = current.get(taskId);
	if (!moved || moved.status === 'done' || normalizedCategory(moved.category) !== normalizedSource) throw new Error('Invalid task move');

	const updates = new Map<string, { category: string | null; priority_position: number }>();
	for (let index = 0; index < sourceTaskIds.length; index += 1) {
		const task = current.get(sourceTaskIds[index]);
		if (!task || task.id === taskId || task.status === 'done' || normalizedCategory(task.category) !== normalizedSource || updates.has(task.id)) {
			throw new Error('Invalid task move');
		}
		updates.set(task.id, { category: normalizedSource, priority_position: index });
	}
	for (let index = 0; index < destinationTaskIds.length; index += 1) {
		const id = destinationTaskIds[index];
		const task = current.get(id);
		if (!task || task.status === 'done' || (id !== taskId && normalizedCategory(task.category) !== normalizedDestination) || updates.has(id)) {
			throw new Error('Invalid task move');
		}
		updates.set(id, { category: normalizedDestination, priority_position: index });
	}
	if (!destinationTaskIds.includes(taskId) || sourceTaskIds.includes(taskId)) throw new Error('Invalid task move');

	tasksState.tasks = tasksState.tasks.map((task) => {
		const update = updates.get(task.id);
		return update ? { ...task, ...update } : task;
	});
	tasksState.tasks = sortTasks(tasksState.tasks, tasksState.categoryPositions, tasksState.sortMode);
	notifyTasksChanged();
}

function applyOptimisticCategoryOrder(categoryNames: (string | null)[]) {
	const existing = new Map(tasksState.categoryPositions.map((position) => [categoryKey(normalizedCategory(position.category_name)), position]));
	const ordered = categoryNames.map((category, index) => {
		const normalized = normalizedCategory(category);
		const previous = existing.get(categoryKey(normalized));
		return {
			id: previous?.id ?? `optimistic-category-${index}`,
			category_name: normalized,
			priority_position: index,
		};
	});
	const orderedKeys = new Set(ordered.map((position) => categoryKey(position.category_name)));
	const remaining = tasksState.categoryPositions.filter((position) => !orderedKeys.has(categoryKey(normalizedCategory(position.category_name))));
	tasksState.categoryPositions = [...ordered, ...remaining];
	tasksState.tasks = sortTasks(tasksState.tasks, tasksState.categoryPositions, tasksState.sortMode);
	notifyTasksChanged();
}

export async function reorderTasksInCategory(projectId: string, category: string | null, taskIds: string[]): Promise<TaskReorderResult> {
	if (!beginReorder()) return { ok: false, error: 'Another reorder is still saving' };
	const operationEpoch = currentEpoch();
	const previous = snapshot();
	try {
		applyOptimisticTaskOrder(category, taskIds);
		const response = await postReorder<TaskOrderResponse>(
			`/api/projects/${projectId}/tasks/reorder`,
			{ type: 'category', category, taskIds },
			'Could not save task order',
		);
		if (currentEpoch() !== operationEpoch) return { ok: false, error: 'Reorder cancelled by navigation' };
		if (!isTaskOrderResponse(response)) throw new Error('Server returned an invalid reorder response');
		applyTaskOrders(response.orders);
		return { ok: true };
	} catch (error) {
		const message = errorMessage(error, 'Could not save task order');
		if (currentEpoch() !== operationEpoch) return { ok: false, error: message };
		restore(previous);
		taskReorderState.error = { scope: 'category', category: normalizedCategory(category), message };
		return { ok: false, error: message };
	} finally {
		if (currentEpoch() === operationEpoch) taskReorderState.pending = false;
	}
}

export async function moveTaskToCategory(
	projectId: string,
	taskId: string,
	sourceCategory: string | null,
	destinationCategory: string | null,
	sourceTaskIds: string[],
	destinationTaskIds: string[],
): Promise<TaskReorderResult> {
	if (!beginReorder()) return { ok: false, error: 'Another reorder is still saving' };
	const operationEpoch = currentEpoch();
	const previous = snapshot();
	try {
		applyOptimisticTaskMove(taskId, sourceCategory, destinationCategory, sourceTaskIds, destinationTaskIds);
		const response = await postReorder<TaskOrderResponse>(
			`/api/projects/${projectId}/tasks/reorder`,
			{ type: 'move', taskId, sourceCategory, destinationCategory, sourceTaskIds, destinationTaskIds },
			'Could not save task move',
		);
		if (currentEpoch() !== operationEpoch) return { ok: false, error: 'Reorder cancelled by navigation' };
		if (!isTaskOrderResponse(response)) throw new Error('Server returned an invalid reorder response');
		applyTaskOrders(response.orders);
		return { ok: true };
	} catch (error) {
		const message = errorMessage(error, 'Could not save task move');
		if (currentEpoch() !== operationEpoch) return { ok: false, error: message };
		restore(previous);
		taskReorderState.error = { scope: 'task', taskId, message };
		return { ok: false, error: message };
	} finally {
		if (currentEpoch() === operationEpoch) taskReorderState.pending = false;
	}
}

export async function reorderTaskCategories(projectId: string, categoryNames: (string | null)[]): Promise<TaskReorderResult> {
	if (!beginReorder()) return { ok: false, error: 'Another reorder is still saving' };
	const operationEpoch = currentEpoch();
	const previous = snapshot();
	try {
		applyOptimisticCategoryOrder(categoryNames);
		const response = await postReorder<CategoryOrderResponse>(
			`/api/projects/${projectId}/task-categories/reorder`,
			{ categoryNames },
			'Could not save category order',
		);
		if (currentEpoch() !== operationEpoch) return { ok: false, error: 'Reorder cancelled by navigation' };
		if (!isCategoryOrderResponse(response)) throw new Error('Server returned an invalid reorder response');
		tasksState.categoryPositions = response.categoryPositions
			.filter((position): position is { id: string; categoryName: string | null; priorityPosition: number } => position.id !== null)
			.map((position) => ({
				id: position.id,
				category_name: normalizedCategory(position.categoryName),
				priority_position: position.priorityPosition,
			}));
		tasksState.tasks = sortTasks(tasksState.tasks, tasksState.categoryPositions, tasksState.sortMode);
		notifyTasksChanged();
		return { ok: true };
	} catch (error) {
		const message = errorMessage(error, 'Could not save category order');
		if (currentEpoch() !== operationEpoch) return { ok: false, error: message };
		restore(previous);
		taskReorderState.error = { scope: 'categories', message };
		return { ok: false, error: message };
	} finally {
		if (currentEpoch() === operationEpoch) taskReorderState.pending = false;
	}
}

export function clearTaskReorderError() {
	taskReorderState.error = null;
}

export function removeTask(id: string) {
	tasksState.tasks = tasksState.tasks.filter((t) => t.id !== id);
	notifyTasksChanged();
}
