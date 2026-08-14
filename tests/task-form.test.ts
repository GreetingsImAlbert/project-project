import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTaskForm } from '../src/lib/task-form.ts';

function formWith(fields: Record<string, string> = {}): FormData {
	const form = new FormData();
	form.set('name', 'Test task');
	form.set('status', 'ongoing');
	for (const [name, value] of Object.entries(fields)) form.set(name, value);
	return form;
}

test('a missing start time defaults to midnight', () => {
	const parsed = parseTaskForm(formWith(), new Set(), new Set());
	assert.equal('error' in parsed, false);
	if ('values' in parsed) {
		assert.equal(parsed.values.start_date, null);
		assert.equal(parsed.values.start_time, '00:00');
	}
});

test('a valid start time is retained', () => {
	const parsed = parseTaskForm(formWith({ start_time: '10:30' }), new Set(), new Set());
	assert.equal('error' in parsed, false);
	if ('values' in parsed) assert.equal(parsed.values.start_time, '10:30');
});

test('an invalid start time is rejected', () => {
	const parsed = parseTaskForm(formWith({ start_time: '24:00' }), new Set(), new Set());
	assert.deepEqual(parsed, { error: 'Start time: not a real time of day' });
});
