import { deadlinePassed, displayStatus } from './task-status';
import type { Task } from './task-columns';

export interface TaskSummary {
	ongoing: number;
	overdue: number;
	total: number;
	nextDue: { date: string; time: string } | null;
}

export function summarizeTasks(tasks: Task[], today: string, nowTime: string): TaskSummary {
	let ongoing = 0;
	let overdue = 0;
	let nextDue: TaskSummary['nextDue'] = null;

	for (const task of tasks) {
		const status = displayStatus(task, today, nowTime);
		if (status === 'ongoing') ongoing += 1;
		if (status === 'overdue') overdue += 1;

		if (
			task.status !== 'done' &&
			task.deadline &&
			!deadlinePassed(task.deadline, task.deadline_time, today, nowTime) &&
			(!nextDue ||
				task.deadline < nextDue.date ||
				(task.deadline === nextDue.date && task.deadline_time < nextDue.time))
		) {
			nextDue = { date: task.deadline, time: task.deadline_time };
		}
	}

	return { ongoing, overdue, total: tasks.length, nextDue };
}
