export const JOURNAL_RETRY_DELAYS_MS = [2_000, 10_000, 30_000] as const;

interface ErrorLike {
	code?: unknown;
	message?: unknown;
	name?: unknown;
	status?: unknown;
	statusCode?: unknown;
	cause?: unknown;
}

function errorLike(value: unknown): ErrorLike | null {
	return typeof value === 'object' && value !== null ? value as ErrorLike : null;
}

function numericStatus(error: ErrorLike): number | null {
	for (const value of [error.status, error.statusCode]) {
		const status = typeof value === 'string' ? Number(value) : value;
		if (typeof status === 'number' && Number.isInteger(status)) return status;
	}
	return null;
}

// Keep retries narrow: validation, authorization, quota, and other permanent
// failures should remain queued for the next normal run rather than consuming
// the cron invocation. PGRST303 is Supabase/PostgREST clock skew; the remaining
// cases are conventional transient HTTP or fetch failures.
export function isTransientJournalError(value: unknown): boolean {
	const error = errorLike(value);
	if (!error) return false;

	if (error.code === 'PGRST303') return true;

	const status = numericStatus(error);
	if (status === 408 || status === 429 || (status !== null && status >= 500 && status <= 599)) {
		return true;
	}

	const message = typeof error.message === 'string' ? error.message : '';
	const name = typeof error.name === 'string' ? error.name : '';
	if (name === 'TypeError' && /fetch|network|connection|socket/i.test(message)) return true;
	if (/^(?:TypeError:\s*)?(?:fetch failed|failed to fetch|networkerror)\b/i.test(message)) return true;
	if (/\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN)\b/i.test(message)) return true;

	return error.cause !== undefined && error.cause !== value
		? isTransientJournalError(error.cause)
		: false;
}

export interface JournalRetryOptions {
	delaysMs?: readonly number[];
	sleep?: (delayMs: number) => Promise<void>;
	onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

export interface JournalRetryIncident {
	outcome: 'recovered' | 'exhausted';
	attempts: number;
	error: unknown;
}

export interface JournalRetryIncidentOptions extends JournalRetryOptions {
	onIncident: (incident: JournalRetryIncident) => Promise<void> | void;
}

function sleep(delayMs: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function retryJournalOperation<T>(
	operation: (attempt: number) => Promise<T>,
	options: JournalRetryOptions = {},
): Promise<T> {
	const delaysMs = options.delaysMs ?? JOURNAL_RETRY_DELAYS_MS;
	const wait = options.sleep ?? sleep;

	for (let attempt = 1; ; attempt++) {
		try {
			return await operation(attempt);
		} catch (error) {
			const delayMs = delaysMs[attempt - 1];
			if (delayMs === undefined || !isTransientJournalError(error)) throw error;

			options.onRetry?.(error, attempt, delayMs);
			await wait(delayMs);
		}
	}
}

// Wraps one complete retry sequence and emits exactly one incident: after a
// successful recovery or after the final/permanent failure. Per-attempt logging
// remains the caller's onRetry responsibility.
export async function retryJournalOperationWithIncident<T>(
	operation: (attempt: number) => Promise<T>,
	options: JournalRetryIncidentOptions,
): Promise<T> {
	let attempts = 0;
	let retryError: unknown;
	let result: T;

	try {
		result = await retryJournalOperation(async (attempt) => {
			attempts = attempt;
			return operation(attempt);
		}, {
			delaysMs: options.delaysMs,
			sleep: options.sleep,
			onRetry: (error, attempt, delayMs) => {
				retryError = error;
				options.onRetry?.(error, attempt, delayMs);
			},
		});
	} catch (error) {
		await options.onIncident({ outcome: 'exhausted', attempts, error });
		throw error;
	}

	if (attempts > 1 && retryError !== undefined) {
		await options.onIncident({ outcome: 'recovered', attempts, error: retryError });
	}

	return result;
}
