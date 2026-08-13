import assert from 'node:assert/strict';
import test from 'node:test';
import {
	JOURNAL_RETRY_DELAYS_MS,
	isTransientJournalError,
	retryJournalOperation,
	retryJournalOperationWithIncident,
} from '../src/lib/journal-retry.ts';
import { appendJournalEntry, parseJournalEntries } from '../src/lib/journal-entries.ts';
import { createJournalCronReport } from '../src/lib/journal-cron-report.ts';

test('journal retry recognizes clock skew and transient transport failures', () => {
	assert.equal(isTransientJournalError({ code: 'PGRST303', message: 'JWT issued at future' }), true);
	assert.equal(isTransientJournalError({ status: 429, message: 'rate limited' }), true);
	assert.equal(isTransientJournalError({ statusCode: 503, message: 'unavailable' }), true);
	assert.equal(isTransientJournalError(new TypeError('fetch failed')), true);
	assert.equal(isTransientJournalError({ message: 'TypeError: fetch failed' }), true);
	assert.equal(isTransientJournalError(new Error('read ECONNRESET')), true);
});

test('journal retry rejects permanent failures', () => {
	assert.equal(isTransientJournalError({ code: '42501', message: 'permission denied' }), false);
	assert.equal(isTransientJournalError({ status: 400, message: 'bad request' }), false);
	assert.equal(isTransientJournalError(new Error('owner is over quota')), false);
});

test('journal operation retries three times with the production backoff', async () => {
	const waits: number[] = [];
	const retries: number[] = [];
	let attempts = 0;

	const result = await retryJournalOperation(async () => {
		attempts++;
		if (attempts < 4) throw { code: 'PGRST303', message: 'JWT issued at future' };
		return 'ok';
	}, {
		sleep: async (delayMs) => { waits.push(delayMs); },
		onRetry: (_error, attempt) => { retries.push(attempt); },
	});

	assert.equal(result, 'ok');
	assert.equal(attempts, 4);
	assert.deepEqual(waits, JOURNAL_RETRY_DELAYS_MS);
	assert.deepEqual(retries, [1, 2, 3]);
});

test('journal operation stops immediately on a permanent failure', async () => {
	let attempts = 0;
	await assert.rejects(
		retryJournalOperation(async () => {
			attempts++;
			throw { code: '42501', message: 'permission denied' };
		}, { sleep: async () => {} }),
		(error: unknown) => (error as { code?: string }).code === '42501',
	);
	assert.equal(attempts, 1);
});

test('journal operation surfaces a transient failure after four attempts', async () => {
	let attempts = 0;
	await assert.rejects(
		retryJournalOperation(async () => {
			attempts++;
			throw { code: 'PGRST303', message: 'JWT issued at future' };
		}, { sleep: async () => {} }),
		(error: unknown) => (error as { code?: string }).code === 'PGRST303',
	);
	assert.equal(attempts, 4);
});

test('retry after a completed journal write replaces rather than duplicates the date', async () => {
	let journal = appendJournalEntry('', '2026-08-12', 'Earlier work');
	let attempts = 0;

	await retryJournalOperation(async () => {
		attempts++;
		journal = appendJournalEntry(journal, '2026-08-13', 'Today\'s work');
		if (attempts === 1) throw { status: 503, message: 'metadata update unavailable' };
	}, {
		delaysMs: [0],
		sleep: async () => {},
	});

	assert.equal(attempts, 2);
	assert.deepEqual(parseJournalEntries(journal), [
		{ date: '2026-08-12', body: 'Earlier work' },
		{ date: '2026-08-13', body: 'Today\'s work' },
	]);
	assert.equal(journal.match(/^## 2026-08-13$/gm)?.length, 1);
});

test('trailing replacement preserves earlier sections when a legacy file repeats a date', () => {
	const legacy = [
		'## 2026-08-13',
		'',
		'Original duplicate',
		'',
		'## 2026-08-14',
		'',
		'Later day',
		'',
		'## 2026-08-13',
		'',
		'Stale trailing duplicate',
		'',
	].join('\n');

	const updated = appendJournalEntry(legacy, '2026-08-13', 'Replacement');
	assert.match(updated, /Original duplicate/);
	assert.match(updated, /## 2026-08-14\n\nLater day/);
	assert.match(updated, /## 2026-08-13\n\nReplacement\n$/);
});

test('journal cron incidents produce one structured admin error-report payload', () => {
	const error = Object.assign(new Error('JWT issued at future'), { code: 'PGRST303', status: 401 });
	const report = createJournalCronReport({
		phase: 'read-stale-drafts',
		outcome: 'recovered',
		attempts: 2,
		error,
		cron: '0 16 * * *',
		scheduledAt: '2026-08-12T16:00:00.000Z',
	});

	assert.equal(report.source, 'server');
	assert.equal(report.method, 'CRON');
	assert.equal(report.path, '/scheduled/journal-finalize');
	assert.match(report.message, /recovered after retry.*2 attempts.*JWT issued at future/);
	assert.deepEqual(report.context, {
		cron: '0 16 * * *',
		scheduledAt: '2026-08-12T16:00:00.000Z',
		phase: 'read-stale-drafts',
		outcome: 'recovered',
		attempts: 2,
		errorCode: 'PGRST303',
		status: 401,
		projectId: null,
	});
});

test('journal cron project reports include project scope and exhausted outcome', () => {
	const report = createJournalCronReport({
		phase: 'finalize-project',
		outcome: 'exhausted',
		attempts: 4,
		error: { message: 'storage unavailable', status: 503 },
		cron: '0 16 * * *',
		scheduledAt: '2026-08-12T16:00:00.000Z',
		projectId: 'project-123',
	});

	assert.match(report.message, /exhausted retries.*4 attempts/);
	assert.equal(report.context?.projectId, 'project-123');
	assert.equal(report.context?.outcome, 'exhausted');
});

test('a recovered retry sequence emits exactly one incident', async () => {
	let attempts = 0;
	const incidents: Array<{ outcome: string; attempts: number }> = [];

	await retryJournalOperationWithIncident(async () => {
		attempts++;
		if (attempts < 3) throw { code: 'PGRST303', message: 'JWT issued at future' };
	}, {
		delaysMs: [0, 0],
		sleep: async () => {},
		onIncident: ({ outcome, attempts: incidentAttempts }) => {
			incidents.push({ outcome, attempts: incidentAttempts });
		},
	});

	assert.deepEqual(incidents, [{ outcome: 'recovered', attempts: 3 }]);
});

test('an exhausted retry sequence emits exactly one incident', async () => {
	const incidents: Array<{ outcome: string; attempts: number }> = [];

	await assert.rejects(retryJournalOperationWithIncident(async () => {
		throw { status: 503, message: 'unavailable' };
	}, {
		delaysMs: [0, 0, 0],
		sleep: async () => {},
		onIncident: ({ outcome, attempts }) => { incidents.push({ outcome, attempts }); },
	}));

	assert.deepEqual(incidents, [{ outcome: 'exhausted', attempts: 4 }]);
});

test('a first-attempt success does not create an incident report', async () => {
	let incidentCount = 0;
	await retryJournalOperationWithIncident(async () => 'ok', {
		onIncident: () => { incidentCount++; },
	});
	assert.equal(incidentCount, 0);
});
