import type { Task, TaskSortMode } from './task-columns';

export interface TaskReorderAccess {
	canEdit: boolean;
	onlyMine: boolean;
	sortMode: TaskSortMode;
	pending: boolean;
}

// Dragging is deliberately unavailable while the list is filtered or a previous
// write is in flight: either condition would make the visible order incomplete.
export function canReorderTask(task: Pick<Task, 'status'>, access: TaskReorderAccess): boolean {
	return access.canEdit && !access.onlyMine && access.sortMode === 'priority' && task.status !== 'done' && !access.pending;
}
