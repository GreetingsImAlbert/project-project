// Transaction dates go straight into a Postgres `date` column. Unlike a task's
// deadline they are required, so this is calendarDateError plus that one rule.
// Shared by the single and bulk transaction endpoints so all four validate alike.

import { calendarDateError } from './calendar-date';

export function transactionDateError(value: string | null | undefined): string | null {
	if (!value) {
		return 'Date is required';
	}

	return calendarDateError(value);
}
