import { calendarDateError } from './calendar-date';
import { isTaskStatus, type TaskStatus } from './task-status';
import { ghostIdOf } from './money-parties';

// Parsing + validation for the task create and update endpoints. Shared for the
// same reason TASK_COLUMNS is: two endpoints writing the same row must agree on
// what they'll accept, or a rule tightened on one silently stays loose on the other.

// Marks a checkbox value in the "Appointed members" picker as naming an existing
// task_assignees row (a deleted account's appointment, kept until explicitly
// unchecked) rather than a project member being newly (or still) appointed —
// same idea as money-parties.ts's GHOST_PREFIX, for the same reason: the two
// live in different id spaces and a submitted token has to say which one it's
// from before either endpoint can act on it.
export const DELETED_ASSIGNEE_PREFIX = 'deleted-assignee:';

export interface TaskFormValues {
	name: string;
	category: string | null;
	description: string | null;
	deadline: string | null;
	status: TaskStatus;
	// Project members and ghost members to (re)appoint, as party tokens — a bare
	// user id or money-parties.ts's `ghost:<id>` — since a task_assignees row can
	// name either.
	assignees: string[];
	// task_assignees.id values of deleted accounts' appointments to keep as-is.
	keptDeletedAssigneeIds: string[];
}

// Which pair of task_assignees columns a party token writes to. Same idea as
// money-parties.ts's partyColumns, just for this table's own column names.
export function taskAssigneeColumns(partyId: string): { user_id: string | null; ghost_member_id: string | null } {
	const ghostId = ghostIdOf(partyId);
	return ghostId ? { user_id: null, ghost_member_id: ghostId } : { user_id: partyId, ghost_member_id: null };
}

export type TaskFormResult = { values: TaskFormValues } | { error: string };

// `memberIds` is the project's membership and `ghostIds` its ghost members.
// Appointing someone is a client-supplied id landing in a row keyed to this
// project, so it gets the same treatment as a client-supplied parent folder id:
// verified against the project before it's used, never trusted because it
// arrived in the form.
export function parseTaskForm(formData: FormData, memberIds: Set<string>, ghostIds: Set<string>): TaskFormResult {
	const name = formData.get('name')?.toString().trim();
	const category = formData.get('category')?.toString().trim() || null;
	const description = formData.get('description')?.toString().trim() || null;
	const deadline = formData.get('deadline')?.toString().trim() || null;
	const statusRaw = formData.get('status')?.toString().trim() || 'ongoing';

	if (!name) {
		return { error: 'Task name is required' };
	}
	if (name.length > 200) {
		return { error: 'Task name: max 200 characters' };
	}
	if (category && category.length > 100) {
		return { error: 'Category: max 100 characters' };
	}
	if (description && description.length > 1000) {
		return { error: 'Description: max 1000 characters' };
	}

	if (deadline) {
		const dateError = calendarDateError(deadline);
		if (dateError) {
			return { error: `Deadline: ${dateError.charAt(0).toLowerCase()}${dateError.slice(1)}` };
		}
	}

	// 'overdue' is deliberately not a storable status — it's derived from the
	// deadline (see task-status.ts), so accepting it here would let a task claim a
	// state the rest of the app computes for itself.
	if (!isTaskStatus(statusRaw)) {
		return { error: 'Status must be Ongoing or Done' };
	}

	const rawTokens = [...new Set(formData.getAll('assignees').map((v) => v.toString()))];
	const assignees: string[] = [];
	const keptDeletedAssigneeIds: string[] = [];

	for (const token of rawTokens) {
		if (token.startsWith(DELETED_ASSIGNEE_PREFIX)) {
			keptDeletedAssigneeIds.push(token.slice(DELETED_ASSIGNEE_PREFIX.length));
			continue;
		}
		const ghostId = ghostIdOf(token);
		if (ghostId) {
			if (!ghostIds.has(ghostId)) {
				return { error: 'Only this project\'s ghost members can be appointed to a task' };
			}
			assignees.push(token);
			continue;
		}
		if (!memberIds.has(token)) {
			return { error: 'Only project members can be appointed to a task' };
		}
		assignees.push(token);
	}

	return { values: { name, category, description, deadline, status: statusRaw, assignees, keptDeletedAssigneeIds } };
}
