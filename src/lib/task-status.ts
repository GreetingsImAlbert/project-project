// Task status, and the one rule that matters about it: `overdue` is never stored.
//
// The column holds only the two states a person can actually choose. A task reads
// as overdue when its deadline has passed and it isn't done — computed at render
// time, so it flips the moment the date rolls over rather than the next time
// somebody happens to open the edit form. A stored third state would be stale by
// definition: nothing in this app runs on a schedule to go and update it.
//
// Everything here takes `today` as an argument rather than calling the clock
// itself. Under SSR the Worker's clock is UTC while the reader's calendar day is
// local, so a component that derived `today` at init would render one status on
// the server and a different one during hydration for the ~8 hours a day the two
// dates disagree. Instead the page passes the server's date down as a prop and each
// island moves to the local date in onMount — a state change *after* hydration,
// which Svelte patches properly, instead of a mismatch it has to reconcile.

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

// YYYY-MM-DD in whatever timezone the runtime is in. On the client that's the
// reader's own calendar day, which is the one a deadline should be judged against.
export function localToday(): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// String comparison is the right one here: zero-padded YYYY-MM-DD sorts
// lexicographically exactly as it does chronologically.
export function displayStatus(task: { status: TaskStatus; deadline: string | null }, today: string): TaskDisplayStatus {
	if (task.status === 'done') return 'done';
	if (task.deadline && task.deadline < today) return 'overdue';
	return 'ongoing';
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
