import type { ErrorReportInput } from './error-report';

export type JournalCronPhase = 'read-stale-drafts' | 'finalize-project';
export type JournalCronOutcome = 'recovered' | 'exhausted';

export interface JournalCronIncident {
	phase: JournalCronPhase;
	outcome: JournalCronOutcome;
	attempts: number;
	error: unknown;
	cron: string | null;
	scheduledAt: string;
	projectId?: string | null;
}

interface ErrorLike {
	code?: unknown;
	message?: unknown;
	stack?: unknown;
	status?: unknown;
}

function errorLike(value: unknown): ErrorLike | null {
	return typeof value === 'object' && value !== null ? value as ErrorLike : null;
}

function stringValue(value: unknown): string | null {
	return typeof value === 'string' && value ? value : null;
}

function statusValue(value: unknown): number | null {
	const status = typeof value === 'string' ? Number(value) : value;
	return typeof status === 'number' && Number.isInteger(status) ? status : null;
}

export function createJournalCronReport(incident: JournalCronIncident): ErrorReportInput {
	const error = errorLike(incident.error);
	const errorMessage = stringValue(error?.message) ?? String(incident.error);
	const action = incident.phase === 'read-stale-drafts' ? 'reading stale drafts' : 'finalizing a project';
	const outcome = incident.outcome === 'recovered' ? 'recovered after retry' : 'exhausted retries';

	return {
		message: `Journal cron ${outcome} while ${action} after ${incident.attempts} attempts: ${errorMessage}`,
		stack: stringValue(error?.stack),
		source: 'server',
		method: 'CRON',
		path: '/scheduled/journal-finalize',
		context: {
			cron: incident.cron,
			scheduledAt: incident.scheduledAt,
			phase: incident.phase,
			outcome: incident.outcome,
			attempts: incident.attempts,
			errorCode: stringValue(error?.code),
			status: statusValue(error?.status),
			projectId: incident.projectId ?? null,
		},
	};
}
