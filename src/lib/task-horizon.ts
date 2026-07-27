// How far ahead the Dashboard's reminders look. The value is a plain day count the
// reader picks themselves, so it lives in a cookie rather than localStorage for the
// same reason the Tasks view mode does: the Dashboard renders the reminder list on
// the server, and a preference only readable after hydration would render two weeks
// of tasks and then visibly swap to whatever the reader actually chose.

export const HORIZON_COOKIE = 'p2-task-horizon-days';

// Fixed options rather than a free number input: the whole control is one select in
// the corner of a section head, and every value here is a span somebody would
// plausibly plan against.
export const HORIZON_OPTIONS = [7, 14, 30, 60] as const;

export const DEFAULT_HORIZON_DAYS = 14;

export function parseHorizonDays(value: string | null | undefined): number {
	const days = Number(value);
	return (HORIZON_OPTIONS as readonly number[]).includes(days) ? days : DEFAULT_HORIZON_DAYS;
}

export function horizonLabel(days: number): string {
	if (days === 7) return 'next week';
	if (days === 14) return 'next 2 weeks';
	if (days % 30 === 0) return `next ${days / 30} month${days === 30 ? '' : 's'}`;
	return `next ${days} days`;
}
