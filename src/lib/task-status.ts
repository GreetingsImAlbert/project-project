// Task status, and the one rule that matters about it: `overdue` is never stored.
//
// The column holds only the two states a person can actually choose. A task reads
// as overdue when its deadline has passed and it isn't done — computed at render
// time from the deadline's date and its time of day (see deadline-time.ts), so it
// flips on the next render past that moment rather than the next time somebody
// happens to open the edit form. A stored third state would be stale by
// definition: nothing in this app runs on a schedule to go and update it.
//
// Everything here takes `today` as an argument rather than calling the clock
// itself, and that argument always comes from appToday() in today.ts — one fixed
// zone for the whole app, server and browser alike. Judging a deadline against the
// reader's own zone instead would mean a task in Manila turning overdue at 4PM for
// a member sitting in UTC, and would have the server and the hydrating island
// disagree for the hours of the day their two dates don't line up.

export type TaskStatus = 'ongoing' | 'done';
export type TaskDisplayStatus = TaskStatus | 'overdue';

export const TASK_STATUS_LABELS: Record<TaskDisplayStatus, string> = {
	ongoing: 'Ongoing',
	done: 'Done',
	overdue: 'Overdue',
};

export function isTaskStatus(value: string | null | undefined): value is TaskStatus {
	return value === 'ongoing' || value === 'done';
}

// String comparison is the right one here: zero-padded YYYY-MM-DD and HH:MM both sort
// lexicographically exactly as they do chronologically.
//
// `nowTime` is the clock half of the same moment `today` is the date half of — both
// from today.ts, both in Asia/Manila — and it only decides the boundary day: a task due
// earlier today is already late, one due later today is not. Everything before or after
// that day is settled by the date alone.
export function displayStatus(
	task: { status: TaskStatus; deadline: string | null; deadline_time: string },
	today: string,
	nowTime: string,
): TaskDisplayStatus {
	if (task.status === 'done') return 'done';
	if (!task.deadline) return 'ongoing';
	if (task.deadline < today) return 'overdue';
	if (task.deadline === today && task.deadline_time < nowTime) return 'overdue';
	return 'ongoing';
}

// Whether a deadline moment has already passed, for the callers that hold a date and a
// time rather than a whole task — the Reminders list, which works from Reminder rows.
export function deadlinePassed(deadline: string, deadlineTime: string, today: string, nowTime: string): boolean {
	if (deadline < today) return true;
	return deadline === today && deadlineTime < nowTime;
}

// Whole days from `today` to `deadline`: negative in the past, 0 for today.
// Both are parsed as UTC midnight so the subtraction can't be knocked off by a
// daylight-saving shift between the two dates.
export function daysUntil(deadline: string, today: string): number {
	const a = Date.parse(`${deadline}T00:00:00Z`);
	const b = Date.parse(`${today}T00:00:00Z`);
	return Math.round((a - b) / 86_400_000);
}

const MONTH_NAMES = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December',
];

// 'July 27' for a deadline in the year that's already on screen everywhere else, and
// 'July 27, 2027' when it isn't — a year that can only be this one is noise in a
// column that has to stay narrow.
//
// Spelled out from the string rather than through toLocaleDateString: the Worker and
// the browser have to produce the same characters or the deadline flickers on
// hydration, and that's a promise about ICU data on both ends rather than about this
// function.
export function formatDeadline(deadline: string, today: string): string {
	const [year, month, day] = deadline.split('-');
	const name = MONTH_NAMES[Number(month) - 1];
	if (!name) return deadline;

	const short = `${name} ${Number(day)}`;
	return year === today.slice(0, 4) ? short : `${short}, ${year}`;
}

// Human phrasing for a deadline relative to today, e.g. 'today', 'in 3 days',
// '2 days ago'. Used by the summary tile and the row detail panel.
export function relativeDeadline(deadline: string, today: string): string {
	const days = daysUntil(deadline, today);
	if (days === 0) return 'today';
	if (days === 1) return 'tomorrow';
	if (days === -1) return 'yesterday';
	if (days > 0) return `in ${days} days`;
	return `${-days} days ago`;
}
