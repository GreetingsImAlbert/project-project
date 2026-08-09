import { sortTasks, type Task, type TaskCategoryPosition } from './task-columns';

export interface TaskExportCategoryPosition {
	category: string | null;
	priorityPosition: number;
}

export interface TaskExportRow {
	id: string;
	name: string;
	category: string | null;
	priorityPosition: number;
	description: string | null;
	startDate: string | null;
	startTime: string;
	deadline: string | null;
	deadlineTime: string;
	status: Task['status'];
	assignees: string[];
}

export interface TaskExportPayload {
	project: string;
	exportedAt: string;
	taskCount: number;
	categoryPositions: TaskExportCategoryPosition[];
	tasks: TaskExportRow[];
}

// Both task JSON downloads use this builder so the standalone export and the ZIP
// cannot disagree about ordering or which priority fields are preserved.
export function buildTaskExportPayload(
	project: string,
	exportedAt: string,
	tasks: Task[],
	categoryPositions: TaskCategoryPosition[] = [],
): TaskExportPayload {
	const orderedTasks = sortTasks(tasks, categoryPositions, 'priority');
	return {
		project,
		exportedAt,
		taskCount: orderedTasks.length,
		categoryPositions: categoryPositions.map((position) => ({
			category: position.category_name,
			priorityPosition: position.priority_position,
		})),
		tasks: orderedTasks.map((task) => ({
			id: task.id,
			name: task.name,
			category: task.category,
			priorityPosition: task.priority_position,
			description: task.description,
			startDate: task.start_date,
			startTime: task.start_time,
			deadline: task.deadline,
			deadlineTime: task.deadline_time,
			status: task.status,
			assignees: task.assignees.map((assignee) => assignee.display_name),
		})),
	};
}
