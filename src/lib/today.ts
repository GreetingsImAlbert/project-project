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
