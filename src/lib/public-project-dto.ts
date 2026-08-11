import type { Task } from './task-columns';

/**
 * Remove database relationship IDs before task props cross the public page
 * boundary. Display names and avatars remain because they are part of the
 * read-only task view; the synthetic row ID keeps Svelte keys stable.
 */
export function toPublicTasks(tasks: Task[]): Task[] {
	return tasks.map((task) => ({
		...task,
		assignees: task.assignees.map((assignee, index) => ({
			...assignee,
			id: `public-assignee-${task.id}-${index}`,
			user_id: null,
			ghost_member_id: null,
		})),
	}));
}
