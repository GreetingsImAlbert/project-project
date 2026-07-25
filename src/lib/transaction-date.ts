// Transaction dates go straight into a Postgres `date` column, which rejects anything
// it can't parse with an error the endpoint would otherwise hand back as a raw 500.
// Shared by the single and bulk transaction endpoints so all four validate alike.

export function transactionDateError(value: string | null | undefined): string | null {
	if (!value) {
		return 'Date is required';
	}

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
