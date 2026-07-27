// A plain calendar date (YYYY-MM-DD) headed for a Postgres `date` column, which
// rejects anything it can't parse with an error the endpoint would otherwise hand
// back as a raw 500. Shared by the transaction endpoints (via transaction-date.ts,
// where the value is required) and the task endpoints (where a deadline is
// optional), so every date the app stores is checked the same way.

export function calendarDateError(value: string): string | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		return 'Date must be YYYY-MM-DD';
	}

	// Catches 2026-02-31 and friends: Date rolls overflow forward, so only a real
	// calendar date round-trips back to the exact string that went in.
	const parsed = new Date(`${value}T00:00:00Z`);
	if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
		return 'Not a real calendar date';
	}

	return null;
}
