import type { TaskStatus } from './task-status';

// The Tasks page's SSR query and every task endpoint hand the same row shape to
// tasks-store's `Task` — kept in one string, like TRANSACTION_COLUMNS, so a newly
// added column can't reach some of those responses and quietly miss the others.
//
// task_assignees has a single FK to profiles (user_id), so the bare embed is
// unambiguous here — no hint needed the way transactions' two profile FKs need one.
export const TASK_COLUMNS =
	'id, name, category, description, deadline, status, task_assignees(id, user_id, deleted_display_name, profiles(display_name))';

export interface TaskAssignee {
	// The task_assignees row's own id — the only stable key once user_id has gone
	// null (a deleted account), which is also why the edit picker in
	// TasksTable.svelte keys a former member's checkbox on this instead.
	id: string;
	user_id: string | null;
	display_name: string;
}

export interface Task {
	id: string;
	name: string;
	category: string | null;
	description: string | null;
	deadline: string | null;
	status: TaskStatus;
	assignees: TaskAssignee[];
}

// What PostgREST actually returns for TASK_COLUMNS, before normalizeTask flattens
// the join rows.
export interface RawTaskRow {
	id: string;
	name: string;
	category: string | null;
	description: string | null;
	deadline: string | null;
	status: string;
	task_assignees: {
		id: string;
		user_id: string | null;
		deleted_display_name: string | null;
		profiles: { display_name: string } | null;
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
		description: row.description,
		deadline: row.deadline,
		// The check constraint only allows these two, so anything else would mean the
		// column drifted from the app — treat it as ongoing rather than widening the type.
		status: row.status === 'done' ? 'done' : 'ongoing',
		assignees: (row.task_assignees ?? [])
			.map((a) => ({
				id: a.id,
				user_id: a.user_id,
				display_name: a.profiles?.display_name ?? a.deleted_display_name ?? '',
			}))
			.sort((a, b) => a.display_name.localeCompare(b.display_name)),
	};
}

// Deadline first (soonest at the top), tasks with no deadline last, name as the
// tiebreak. Applied client-side as well as in the SSR query's `order`, because an
// edit that changes a deadline has to re-sort without a refetch.
export function sortTasks(tasks: Task[]): Task[] {
	return [...tasks].sort((a, b) => {
		if (a.deadline !== b.deadline) {
			if (!a.deadline) return 1;
			if (!b.deadline) return -1;
			return a.deadline < b.deadline ? -1 : 1;
		}
		return a.name.localeCompare(b.name);
	});
}
