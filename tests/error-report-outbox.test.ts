import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
	ERROR_REPORT_OUTBOX_PREFIX,
	flushErrorReportOutbox,
	persistErrorReport,
	type StoredErrorReport,
} from '../src/lib/error-report-outbox.ts';

class FakeBucket {
	objects = new Map<string, string>();
	deleted: string[] = [];

	async put(key: string, value: string) {
		this.objects.set(key, value);
	}

	async get(key: string) {
		const value = this.objects.get(key);
		return value === undefined ? null : { text: async () => value };
	}

	async list({ prefix }: { prefix: string }) {
		return {
			objects: [...this.objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
			truncated: false,
		};
	}

	async delete(key: string) {
		this.deleted.push(key);
		this.objects.delete(key);
	}
}

function report(id = 'REPORT23'): StoredErrorReport {
	return {
		id,
		message: 'Journal cron exhausted retries',
		stack: null,
		source: 'server',
		method: 'CRON',
		path: '/scheduled/journal-finalize',
		url: null,
		user_id: null,
		context: { outcome: 'exhausted' },
		created_at: '2026-08-13T00:00:00.000Z',
	};
}

function fakeAdmin(options: { insertError?: string; insertThrows?: string; upsertError?: string } = {}) {
	const inserted: StoredErrorReport[] = [];
	const upserted: Array<{ value: StoredErrorReport; options: unknown }> = [];
	const admin = {
		from(table: string) {
			assert.equal(table, 'error_reports');
			return {
				async insert(value: StoredErrorReport) {
					inserted.push(value);
					if (options.insertThrows) throw new Error(options.insertThrows);
					return { error: options.insertError ? { message: options.insertError } : null };
				},
				async upsert(value: StoredErrorReport, upsertOptions: unknown) {
					upserted.push({ value, options: upsertOptions });
					return { error: options.upsertError ? { message: options.upsertError } : null };
				},
			};
		},
	};
	return { admin, inserted, upserted };
}

test('failed database insert queues the bounded report in private R2 storage', async () => {
	const bucket = new FakeBucket();
	const { admin } = fakeAdmin({ insertError: 'JWT issued at future' });
	const value = report();

	const result = await persistErrorReport(admin as never, value, bucket as unknown as R2Bucket);

	assert.deepEqual(result, {
		persisted: false,
		queued: true,
		databaseError: 'JWT issued at future',
		outboxError: null,
	});
	assert.equal(bucket.objects.size, 1);
	assert.ok([...bucket.objects.keys()][0].startsWith(ERROR_REPORT_OUTBOX_PREFIX));
	assert.match([...bucket.objects.values()][0], /Journal cron exhausted retries/);
});

test('successful insert does not create an outbox object', async () => {
	const bucket = new FakeBucket();
	const { admin } = fakeAdmin();
	const result = await persistErrorReport(admin as never, report(), bucket as unknown as R2Bucket);

	assert.equal(result.persisted, true);
	assert.equal(result.queued, false);
	assert.equal(bucket.objects.size, 0);
});

test('thrown database failures also fall back without escaping the logger', async () => {
	const bucket = new FakeBucket();
	const { admin } = fakeAdmin({ insertThrows: 'fetch failed' });

	const result = await persistErrorReport(admin as never, report(), bucket as unknown as R2Bucket);

	assert.equal(result.persisted, false);
	assert.equal(result.queued, true);
	assert.equal(result.databaseError, 'fetch failed');
	assert.equal(bucket.objects.size, 1);
});

test('flush idempotently upserts queued reports then deletes their objects', async () => {
	const bucket = new FakeBucket();
	const queued = report();
	await persistErrorReport(
		fakeAdmin({ insertError: 'temporarily unavailable' }).admin as never,
		queued,
		bucket as unknown as R2Bucket,
	);
	const { admin, upserted } = fakeAdmin();

	const result = await flushErrorReportOutbox(admin as never, bucket as unknown as R2Bucket);

	assert.deepEqual(result, { flushed: 1, retained: 0 });
	assert.equal(bucket.objects.size, 0);
	assert.equal(bucket.deleted.length, 1);
	assert.deepEqual(upserted, [{
		value: queued,
		options: { onConflict: 'id', ignoreDuplicates: true },
	}]);
});

test('failed flush retains the report for a later attempt', async () => {
	const bucket = new FakeBucket();
	await persistErrorReport(
		fakeAdmin({ insertError: 'temporarily unavailable' }).admin as never,
		report(),
		bucket as unknown as R2Bucket,
	);
	const { admin } = fakeAdmin({ upsertError: 'still unavailable' });

	const result = await flushErrorReportOutbox(admin as never, bucket as unknown as R2Bucket);

	assert.deepEqual(result, { flushed: 0, retained: 1 });
	assert.equal(bucket.objects.size, 1);
	assert.equal(bucket.deleted.length, 0);
});

test('invalid outbox objects are retained rather than discarded', async () => {
	const bucket = new FakeBucket();
	await bucket.put(`${ERROR_REPORT_OUTBOX_PREFIX}broken.json`, '{not json');

	const result = await flushErrorReportOutbox(fakeAdmin().admin as never, bucket as unknown as R2Bucket);

	assert.deepEqual(result, { flushed: 0, retained: 1 });
	assert.equal(bucket.objects.size, 1);
});

test('admin error dashboard renders structured report context', () => {
	const page = readFileSync(new URL('../src/pages/admin/errors.astro', import.meta.url), 'utf8');
	assert.match(page, /report\.context !== null/);
	assert.match(page, /JSON\.stringify\(report\.context, null, 2\)/);
	assert.match(page, />Context</);
});
