// The time-of-day half of a task deadline: a `time` column next to the `date` one,
// not a `timestamptz` replacing it.
//
// Keeping the calendar day its own column is what lets everything that already
// reasons about deadlines keep comparing plain zero-padded strings — the calendar
// grid groups by it, the summary sorts on it, `deadline < today` decides overdue —
// while a timestamp would have dragged an offset into every one of those and made
// the grouping key depend on the reader's zone. The pair is read as one moment in
// Asia/Manila (see today.ts), which is the only zone this app has.
//
// The column is `not null default '23:59'` because a deadline with no stated time
// is a deadline at the end of its day: that's the same thing, spelled out, and it
// means the overdue rule never has to branch on a missing value. Rows written
// before the column existed took the default, which is exactly right for them.

// End of day. The form pre-fills it, and every task that predates the column has it.
export const DEFAULT_DEADLINE_TIME = '23:59';

// Postgres hands a `time` column back as 'HH:MM:SS' while <input type="time"> both
// emits and expects 'HH:MM'. Everything above this module works in the input's shape,
// so the seconds are dropped on the way in — they're always :00, since nothing in the
// app can write anything else.
export function normalizeDeadlineTime(value: string | null | undefined): string {
	if (!value) return DEFAULT_DEADLINE_TIME;
	return value.slice(0, 5);
}

export function deadlineTimeError(value: string): string | null {
	const match = /^(\d{2}):(\d{2})$/.exec(value);
	if (!match) {
		return 'Time must be HH:MM';
	}

	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	if (hours > 23 || minutes > 59) {
		return 'Not a real time of day';
	}

	return null;
}

// '11:59 PM'. Spelled out from the string rather than through toLocaleTimeString for
// the same reason formatDeadline is (see task-status.ts): the Worker and the browser
// have to produce the same characters or the value changes on hydration.
export function formatDeadlineTime(value: string): string {
	const [rawHours, minutes] = value.split(':');
	const hours = Number(rawHours);
	if (!Number.isInteger(hours) || minutes === undefined) return value;

	const suffix = hours < 12 ? 'AM' : 'PM';
	const hour12 = hours % 12 === 0 ? 12 : hours % 12;
	return `${hour12}:${minutes} ${suffix}`;
}
