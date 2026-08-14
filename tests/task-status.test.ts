import assert from 'node:assert/strict';
import test from 'node:test';
import { displayStatus } from '../src/lib/task-status.ts';

const task = {
	status: 'ongoing' as const,
	start_date: '2026-08-09',
	start_time: '10:00',
	deadline: null,
	deadline_time: '23:59',
};

test('a task starting later today is not started yet', () => {
	assert.equal(displayStatus(task, '2026-08-09', '09:59'), 'not-started');
});

test('a task becomes ongoing at its start time', () => {
	assert.equal(displayStatus(task, '2026-08-09', '10:00'), 'ongoing');
	assert.equal(displayStatus(task, '2026-08-09', '10:01'), 'ongoing');
});

test('date boundaries still take precedence over the clock', () => {
	assert.equal(displayStatus({ ...task, start_date: '2026-08-08' }, '2026-08-08', '23:59'), 'ongoing');
	assert.equal(displayStatus({ ...task, start_date: '2026-08-11' }, '2026-08-10', '00:01'), 'not-started');
});

test('done remains done even before its planned start', () => {
	assert.equal(displayStatus({ ...task, status: 'done' }, '2026-08-09', '09:59'), 'done');
});

test('deadline time still controls overdue on the boundary day', () => {
	assert.equal(
		displayStatus({ ...task, start_time: '08:00', deadline: '2026-08-09', deadline_time: '09:59' }, '2026-08-09', '10:00'),
		'overdue',
	);
});

test('a task without a start date is not started', () => {
	assert.equal(displayStatus({ ...task, start_date: null }, '2026-08-09', '10:00'), 'not-started');
});

test('a task without a start date becomes overdue once its deadline passes', () => {
	assert.equal(
		displayStatus({ ...task, start_date: null, deadline: '2026-08-09', deadline_time: '09:59' }, '2026-08-09', '10:00'),
		'overdue',
	);
});
