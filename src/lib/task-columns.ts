import { normalizeDeadlineTime, normalizeStartTime } from './deadline-time';
import type { TaskStatus } from './task-status';

// The Tasks page's SSR query and every task endpoint hand the same row shape to
// tasks-store's `Task` — kept in one string, like TRANSACTION_COLUMNS, so a newly
// added column can't reach some of those responses and quietly miss the others.
//
// task_assignees has a single FK to profiles (user_id) and a single FK to
// ghost_members (ghost_member_id), so both bare embeds are unambiguous here — no
// hint needed the way transactions' two-FKs-to-the-same-table pairs need one.
export const TASK_COLUMNS =
	'id, name, category, priority_position, description, start_date, start_time, deadline, deadline_time, status, task_assignees(id, user_id, ghost_member_id, deleted_display_name, profiles(display_name, avatar), ghost_members(display_name))';
export const TASK_CATEGORY_POSITION_COLUMNS = 'id, category_name, priority_position';

// The project-level order is a separate table because task categories remain free
// text. The client keeps the row id as the stable fallback when two positions are
// temporarily equal during a concurrent reorder.
export interface TaskCategoryPosition {
	id: string;
	category_name: string | null;
	priority_position: number;
}

export interface TaskAssignee {
	// The task_assignees row's own id — the only stable key once user_id has gone
	// null (a deleted account), which is also why the edit picker in
	// TasksTable.svelte keys a former member's checkbox on this instead.
	id: string;
	user_id: string | null;
	ghost_member_id: string | null;
	display_name: string;
	// Null for a ghost and for a deleted account as well as for a member who never
	// picked one — all three render as the initial (see Avatar.svelte).
	avatar: string | null;
}

export interface Task {
	id: string;
	name: string;
	category: string | null;
	priority_position: number;
	description: string | null;
	start_date: string | null;
	// Time of day the task starts, always 'HH:MM' and defaulting to midnight. It is
	// meaningless when `start_date` is null.
	start_time: string;
	deadline: string | null;
	// Time of day the deadline falls at, always 'HH:MM' and never null — a dated task
	// with no stated time is due at the end of its day. Meaningless (and unread) when
	// `deadline` is null. See deadline-time.ts.
	deadline_time: string;
	status: TaskStatus;
	assignees: TaskAssignee[];
}

// What PostgREST actually returns for TASK_COLUMNS, before normalizeTask flattens
// the join rows.
export interface RawTaskRow {
	id: string;
	name: string;
	category: string | null;
	priority_position: number;
	description: string | null;
	start_date: string | null;
	start_time: string;
	deadline: string | null;
	// 'HH:MM:SS' out of Postgres; normalizeTask trims it to the 'HH:MM' the rest of the
	// app (and <input type="time">) works in.
	deadline_time: string;
	status: string;
	task_assignees: {
		id: string;
		user_id: string | null;
		ghost_member_id: string | null;
		deleted_display_name: string | null;
		profiles: { display_name: string; avatar: string | null } | null;
		ghost_members: { display_name: string } | null;
	}[];
}

// Flattens `task_assignees(user_id, profiles(display_name))` into a plain array the
// client can render directly, and sorts it by name so the list cell and the detail
// panel agree regardless of what order the join came back in.
export function normalizeTask(row: RawTaskRow): Task {
	return {
		id: row.id,
		name: row.name,
		category: row.category,
		priority_position: row.priority_position,
		description: row.description,
		start_date: row.start_date,
		start_time: normalizeStartTime(row.start_time),
		deadline: row.deadline,
		deadline_time: normalizeDeadlineTime(row.deadline_time),
		// The check constraint only allows these two, so anything else would mean the
		// column drifted from the app — treat it as ongoing rather than widening the type.
		status: row.status === 'done' ? 'done' : 'ongoing',
		assignees: (row.task_assignees ?? [])
			.map((a) => ({
				id: a.id,
				user_id: a.user_id,
				ghost_member_id: a.ghost_member_id,
				display_name: a.profiles?.display_name ?? a.ghost_members?.display_name ?? a.deleted_display_name ?? '',
				avatar: a.profiles?.avatar ?? null,
			}))
			.sort((a, b) => a.display_name.localeCompare(b.display_name)),
	};
}

// Deadline first (soonest at the top), then time of day within the same date, tasks
// with no deadline last, name as the tiebreak. Applied client-side as well as in the
// SSR query's `order`, because an edit that changes a deadline has to re-sort without
// a refetch.
function sortTasksLegacy(tasks: Task[]): Task[] {
	return [...tasks].sort((a, b) => {
		if (a.deadline !== b.deadline) {
			if (!a.deadline) return 1;
			if (!b.deadline) return -1;
			return a.deadline < b.deadline ? -1 : 1;
		}
		// Only meaningful once both sit on the same day — and when neither has a date at
		// all, both times are the column default, so this falls through to the name.
		if (a.deadline && a.deadline_time !== b.deadline_time) {
			return a.deadline_time < b.deadline_time ? -1 : 1;
		}
		return a.name.localeCompare(b.name);
	});
}

void sortTasksLegacy;

export type TaskSortMode = 'priority' | 'deadline';

export const TASK_SORT_MODE_COOKIE = 'p2-task-sort-mode';

export function isTaskSortMode(value: unknown): value is TaskSortMode {
	return value === 'priority' || value === 'deadline';
}

function normalizedCategory(category: string | null): string | null {
	return category?.trim() || null;
}

function compareIds(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function compareNullableCategories(a: string | null, b: string | null): number {
	if (a === b) return 0;
	if (a === null) return 1;
	if (b === null) return -1;
	return a.localeCompare(b) || compareIds(a, b);
}

function categoryPositionMap(categoryPositions: TaskCategoryPosition[]): Map<string | null, TaskCategoryPosition> {
	return new Map(categoryPositions.map((position) => [normalizedCategory(position.category_name), position]));
}

// Done is a display-only group, so it stays below every editable category even
// though completed rows retain their real category and persisted priority.
function compareCategories(a: Task, b: Task, positions: Map<string | null, TaskCategoryPosition>): number {
	const aDone = a.status === 'done';
	const bDone = b.status === 'done';
	if (aDone !== bDone) return aDone ? 1 : -1;
	if (aDone) return 0;

	const aCategory = normalizedCategory(a.category);
	const bCategory = normalizedCategory(b.category);
	const aPosition = positions.get(aCategory);
	const bPosition = positions.get(bCategory);
	const aRank = aPosition?.priority_position ?? Number.MAX_SAFE_INTEGER;
	const bRank = bPosition?.priority_position ?? Number.MAX_SAFE_INTEGER;

	if (aRank !== bRank) return aRank < bRank ? -1 : 1;
	if (aPosition && bPosition && aPosition.id !== bPosition.id) return compareIds(aPosition.id, bPosition.id);
	return compareNullableCategories(aCategory, bCategory);
}

function comparePriorityTasks(a: Task, b: Task): number {
	if (a.priority_position !== b.priority_position) return a.priority_position < b.priority_position ? -1 : 1;
	return compareIds(a.id, b.id);
}

function compareDeadlineTasks(a: Task, b: Task): number {
	if (a.deadline !== b.deadline) {
		if (!a.deadline) return 1;
		if (!b.deadline) return -1;
		return a.deadline < b.deadline ? -1 : 1;
	}
	// Only meaningful once both sit on the same day — and when neither has a date at
	// all, both times are the column default, so this falls through to the name.
	if (a.deadline && a.deadline_time !== b.deadline_time) {
		return a.deadline_time < b.deadline_time ? -1 : 1;
	}
	return a.name.localeCompare(b.name) || compareIds(a.id, b.id);
}

// Category order is applied before the selected within-category order. Keeping this
// as one flat sort means the grouped list, calendar, reminders, and later optimistic
// edits can all use exactly the same deterministic rules.
export function sortTasks(tasks: Task[], categoryPositions: TaskCategoryPosition[] = [], mode: TaskSortMode = 'deadline'): Task[] {
	const positions = categoryPositionMap(categoryPositions);
	return [...tasks].sort((a, b) => {
		const categoryComparison = compareCategories(a, b, positions);
		if (categoryComparison !== 0) return categoryComparison;
		return mode === 'priority' ? comparePriorityTasks(a, b) : compareDeadlineTasks(a, b);
	});
}
