// The one place the app decides what day it is.
//
// Every calendar day this app draws a line on — a Journal draft rolling into its
// file, a task deadline turning overdue — is a day in Asia/Manila, not in the
// Worker's UTC and not in whatever zone the reader's browser happens to be set to.
// A project's members share one schedule, so they need one calendar; picking the
// zone the work actually happens in is what makes "due today" mean the same thing
// to the server, to every open tab, and to the nightly Cron Trigger (which is a
// UTC expression in wrangler.jsonc and so carries the +08:00 offset in its hour).
//
// Because this is a fixed zone rather than the runtime's, SSR and hydration agree
// by construction: there's no window in the day where the server renders one date
// and the browser another.
export const APP_TIME_ZONE = 'Asia/Manila';

// 'en-CA' because its short date format is exactly YYYY-MM-DD — the same shape
// Postgres `date` columns come back as, so these strings compare directly against
// stored deadlines and draft dates.
const dateFormat = new Intl.DateTimeFormat('en-CA', {
	timeZone: APP_TIME_ZONE,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
});

export function appToday(): string {
	return dateFormat.format(new Date());
}

// 'HH:MM' in the same zone, zero-padded and 24-hour so it compares lexicographically
// against a task's stored deadline time exactly as it does chronologically — the same
// property appToday()'s format relies on. 'en-GB' with hour12 off is the combination
// that never produces a '24:00' hour for midnight.
const timeFormat = new Intl.DateTimeFormat('en-GB', {
	timeZone: APP_TIME_ZONE,
	hour: '2-digit',
	minute: '2-digit',
	hour12: false,
});

// The clock half of "now", for the one rule that needs it: a task whose deadline is
// today is overdue only once its time has passed. Read on the server and handed to
// the islands as a prop, like appToday(), so the two never disagree on hydration —
// which does mean the page's sense of "now" is the moment it was rendered.
export function appNowTime(): string {
	return timeFormat.format(new Date());
}
