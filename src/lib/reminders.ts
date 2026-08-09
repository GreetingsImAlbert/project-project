import { categoryColorIndex, type CategoryColors } from './category-color';
import { sortTasks, type Task, type TaskCategoryPosition } from './task-columns';

// One row of the Reminders list, in the shape both callers of UpcomingTasks hand it:
// a project's Overview (every open task in that project) and the Dashboard (only the
// reader's own tasks, across every project they're in).
//
// It's flattened rather than a `Task` plus context because the two pages source their
// tasks from different queries — the Dashboard's joins `task_assignees` inner so it can
// filter on the reader, which changes the row shape PostgREST returns. What the list
// actually renders is this handful of fields, so this is what they agree on.
//
// `colorIndex` is resolved here rather than in the component: category colours are
// per-project (`task_categories` is keyed by project_id), so a Dashboard list spanning
// several projects can't be handed one CategoryColors map to look them up in. Neither
// page edits tasks, so resolving once on the server costs nothing.
export interface Reminder {
	id: string;
	name: string;
	startDate: string | null;
	// 'HH:MM', the time of day the task starts; midnight preserves date-only tasks.
	startTime: string;
	// Never null: a task with no deadline can't come due, so it never becomes a reminder.
	deadline: string;
	// 'HH:MM', the time of day that deadline falls at — see deadline-time.ts.
	deadlineTime: string;
	status: Task['status'];
	colorIndex: number | null;
	projectId: string;
	// The project's name, or null on a page that's already about one project and would
	// only be repeating itself.
	projectName: string | null;
	// Whether the reader is appointed to it — what the 'Just my tasks' filter reads.
	mine: boolean;
	// Ordering metadata lets the reminder component sort each deadline bucket by the
	// project's category order and the task's local priority.
	categoryName: string | null;
	categoryPosition: number;
	categoryPositionId: string | null;
	priorityPosition: number;
}

// The Overview's mapping: full task rows for one project, with that project's colours.
// The Dashboard builds its own, since its rows carry a project name and this one doesn't.
export function projectReminders(
	tasks: Task[],
	projectId: string,
	colors: CategoryColors,
	currentUserId: string,
	categoryPositions: TaskCategoryPosition[] = [],
): Reminder[] {
	const positions = new Map(
		categoryPositions.map((position) => [position.category_name?.trim() || null, position]),
	);

	return sortTasks(tasks, categoryPositions, 'priority')
		.filter((task) => task.deadline !== null)
		.map((task) => {
			const categoryName = task.category?.trim() || null;
			const position = positions.get(categoryName);
			return {
				id: task.id,
				name: task.name,
				startDate: task.start_date,
				startTime: task.start_time,
				deadline: task.deadline!,
				deadlineTime: task.deadline_time,
				status: task.status,
				colorIndex: categoryColorIndex(task.category, colors),
				projectId,
				projectName: null,
				mine: task.assignees.some((a) => a.user_id === currentUserId),
				categoryName,
				categoryPosition: position?.priority_position ?? Number.MAX_SAFE_INTEGER,
				categoryPositionId: position?.id ?? null,
				priorityPosition: task.priority_position,
			};
		});
}

function compareIds(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function compareCategories(a: Reminder, b: Reminder): number {
	if (a.categoryPosition !== b.categoryPosition) return a.categoryPosition < b.categoryPosition ? -1 : 1;
	if (a.categoryPositionId !== b.categoryPositionId) {
		if (a.categoryPositionId === null) return 1;
		if (b.categoryPositionId === null) return -1;
		const byId = compareIds(a.categoryPositionId, b.categoryPositionId);
		if (byId !== 0) return byId;
	}
	if (a.categoryName !== b.categoryName) {
		if (a.categoryName === null) return 1;
		if (b.categoryName === null) return -1;
		const byName = a.categoryName.localeCompare(b.categoryName);
		if (byName !== 0) return byName;
	}
	return 0;
}

// Both reminder buckets use the same category-first, local-priority order. Keeping
// the comparator here also protects future reminder callers from query-order drift.
export function sortReminders(reminders: Reminder[]): Reminder[] {
	return [...reminders].sort(
		(a, b) => compareCategories(a, b) || a.priorityPosition - b.priorityPosition || compareIds(a.id, b.id),
	);
}
