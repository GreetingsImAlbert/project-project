// The Journal file's markdown shape: one `## YYYY-MM-DD` section per day, oldest
// first (append-only — see journal.ts's finalize step, the only writer of new
// sections). Parsing/appending live here, independent of R2 and Supabase, so both
// the SSR page (read) and the cron finalize job (write) share one definition of
// the format.

const DAY_HEADING = /^## (\d{4}-\d{2}-\d{2})$/;

export interface JournalEntry {
	date: string;
	body: string;
}

// Oldest first, matching the file itself. The Journal page reverses this for
// display — newest first reads like a log, but appending stays a plain tail-write.
export function parseJournalEntries(content: string): JournalEntry[] {
	const lines = content.replace(/\r\n?/g, '\n').split('\n');
	const entries: JournalEntry[] = [];

	for (const line of lines) {
		const match = DAY_HEADING.exec(line);
		if (match) {
			entries.push({ date: match[1], body: '' });
			continue;
		}
		if (entries.length > 0) {
			entries[entries.length - 1].body += `${line}\n`;
		}
	}

	return entries.map((entry) => ({ date: entry.date, body: entry.body.trim() }));
}

// A trailing entry for `date` (same day finalized twice — the cron job missed a
// run and caught up) replaces its body instead of duplicating the heading.
export function appendJournalEntry(content: string, date: string, body: string): string {
	const trimmedBody = body.trim();
	const section = `## ${date}\n\n${trimmedBody}\n`;

	const entries = parseJournalEntries(content);
	const last = entries[entries.length - 1];

	if (last && last.date === date) {
		const lines = content.replace(/\r\n?/g, '\n').split('\n');
		const headingIndex = lines.findIndex((line) => line === `## ${date}`);
		return `${lines.slice(0, headingIndex).join('\n').trimEnd()}\n\n${section}`.trimStart();
	}

	const base = content.trim();
	return base ? `${base}\n\n${section}` : section;
}
