import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from './supabase/database.types';

export const ERROR_REPORT_OUTBOX_PREFIX = '_system/error-report-outbox/';

export interface StoredErrorReport {
	id: string;
	message: string;
	stack: string | null;
	source: string;
	method: string | null;
	path: string | null;
	url: string | null;
	user_id: string | null;
	context: Json | null;
	created_at: string;
}

interface OutboxEnvelope {
	version: 1;
	report: StoredErrorReport;
}

export interface PersistErrorReportResult {
	persisted: boolean;
	queued: boolean;
	databaseError: string | null;
	outboxError: string | null;
}

export interface FlushErrorReportOutboxResult {
	flushed: number;
	retained: number;
}

function outboxKey(id: string): string {
	return `${ERROR_REPORT_OUTBOX_PREFIX}${id}.json`;
}

function nullableString(value: unknown): value is string | null {
	return value === null || typeof value === 'string';
}

function isStoredErrorReport(value: unknown): value is StoredErrorReport {
	if (typeof value !== 'object' || value === null) return false;
	const report = value as Partial<StoredErrorReport>;
	return typeof report.id === 'string'
		&& typeof report.message === 'string'
		&& typeof report.source === 'string'
		&& typeof report.created_at === 'string'
		&& nullableString(report.stack)
		&& nullableString(report.method)
		&& nullableString(report.path)
		&& nullableString(report.url)
		&& nullableString(report.user_id)
		&& (report.context === null || typeof report.context === 'object');
}

function parseEnvelope(raw: string): OutboxEnvelope | null {
	try {
		const value = JSON.parse(raw) as Partial<OutboxEnvelope>;
		return value.version === 1 && isStoredErrorReport(value.report)
			? value as OutboxEnvelope
			: null;
	} catch {
		return null;
	}
}

export async function queueErrorReport(bucket: R2Bucket, report: StoredErrorReport): Promise<void> {
	const envelope: OutboxEnvelope = { version: 1, report };
	await bucket.put(outboxKey(report.id), JSON.stringify(envelope), {
		httpMetadata: { contentType: 'application/json' },
	});
}

export async function persistErrorReport(
	admin: SupabaseClient<Database>,
	report: StoredErrorReport,
	bucket?: R2Bucket,
): Promise<PersistErrorReportResult> {
	let databaseError: string | null = null;
	try {
		const { error } = await admin.from('error_reports').insert(report);
		if (!error) {
			return { persisted: true, queued: false, databaseError: null, outboxError: null };
		}
		databaseError = error.message;
	} catch (error) {
		databaseError = error instanceof Error ? error.message : String(error);
	}

	if (!bucket) {
		return { persisted: false, queued: false, databaseError, outboxError: null };
	}

	try {
		await queueErrorReport(bucket, report);
		return { persisted: false, queued: true, databaseError, outboxError: null };
	} catch (outboxError) {
		return {
			persisted: false,
			queued: false,
			databaseError,
			outboxError: outboxError instanceof Error ? outboxError.message : String(outboxError),
		};
	}
}

export async function flushErrorReportOutbox(
	admin: SupabaseClient<Database>,
	bucket?: R2Bucket,
): Promise<FlushErrorReportOutboxResult> {
	if (!bucket) return { flushed: 0, retained: 0 };

	let flushed = 0;
	let retained = 0;
	let cursor: string | undefined;

	try {
		do {
			const page = await bucket.list({ prefix: ERROR_REPORT_OUTBOX_PREFIX, cursor });

			for (const item of page.objects) {
				try {
					const object = await bucket.get(item.key);
					if (!object) continue;

					const envelope = parseEnvelope(await object.text());
					if (!envelope) {
						retained++;
						console.error(`[error-report] invalid outbox object retained: ${item.key}`);
						continue;
					}

					const { error } = await admin
						.from('error_reports')
						.upsert(envelope.report, { onConflict: 'id', ignoreDuplicates: true });

					if (error) {
						retained++;
						console.error(`[error-report] failed to flush report ${envelope.report.id}: ${error.message}`);
						continue;
					}

					await bucket.delete(item.key);
					flushed++;
				} catch (error) {
					retained++;
					console.error(`[error-report] failed to process outbox object ${item.key}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}

			cursor = page.truncated ? page.cursor : undefined;
		} while (cursor);
	} catch (error) {
		console.error(`[error-report] failed to list outbox: ${error instanceof Error ? error.message : String(error)}`);
	}

	return { flushed, retained };
}
