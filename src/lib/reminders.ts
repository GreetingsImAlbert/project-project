import { categoryColorIndex, type CategoryColors } from './category-color';
import type { Task } from './task-columns';

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
	// Never null: a task with no deadline can't come due, so it never becomes a reminder.
	deadline: string;
	// 'HH:MM', the time of day that deadline falls at — see deadline-time.ts.
	deadlineTime: string;
	colorIndex: number | null;
	projectId: string;
	// The project's name, or null on a page that's already about one project and would
	// only be repeating itself.
	projectName: string | null;
	// Whether the reader is appointed to it — what the 'Just my tasks' filter reads.
	mine: boolean;
}

// The Overview's mapping: full task rows for one project, with that project's colours.
// The Dashboard builds its own, since its rows carry a project name and this one doesn't.
export function projectReminders(tasks: Task[], projectId: string, colors: CategoryColors, currentUserId: string): Reminder[] {
	return tasks
		.filter((task) => task.deadline !== null)
		.map((task) => ({
			id: task.id,
			name: task.name,
			deadline: task.deadline!,
			deadlineTime: task.deadline_time,
			colorIndex: categoryColorIndex(task.category, colors),
			projectId,
			projectName: null,
			mine: task.assignees.some((a) => a.user_id === currentUserId),
		}));
}
