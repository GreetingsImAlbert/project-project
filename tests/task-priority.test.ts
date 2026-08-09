import assert from 'node:assert/strict';
import test from 'node:test';
import {
	parseCategoryReorderPayload,
	parseTaskReorderPayload,
	expectedRpcErrorResponse,
} from '../src/lib/task-reorder.ts';
import { sortTasks, type Task, type TaskCategoryPosition } from '../src/lib/task-columns.ts';
import { canReorderTask } from '../src/lib/task-ordering.ts';
import { canEditTasks } from '../src/lib/task-permissions.ts';
import { buildTaskExportPayload } from '../src/lib/task-export.ts';
import { projectReminders, sortReminders } from '../src/lib/reminders.ts';

function makeTask(overrides: Partial<Task> = {}): Task {
	return {
		id: 'task-default',
		name: 'Task',
		category: 'Alpha',
		priority_position: 0,
		description: null,
		start_date: null,
		start_time: '00:00',
		deadline: null,
		deadline_time: '23:59',
		status: 'ongoing',
		assignees: [],
		...overrides,
	};
}

const categoryPositions: TaskCategoryPosition[] = [
	{ id: 'category-beta', category_name: 'Beta', priority_position: 0 },
	{ id: 'category-alpha', category_name: 'Alpha', priority_position: 1 },
];

test('priority and deadline modes use deterministic category and task ordering', () => {
	const tasks = [
		makeTask({ id: 'alpha-late', name: 'Late', category: 'Alpha', priority_position: 2, deadline: '2026-08-12' }),
		makeTask({ id: 'beta', name: 'Beta task', category: 'Beta', priority_position: 0, deadline: '2026-08-13' }),
		makeTask({ id: 'alpha-first', name: 'First', category: 'Alpha', priority_position: 0, deadline: '2026-08-14' }),
		makeTask({ id: 'done', name: 'Completed', category: 'Beta', priority_position: 0, status: 'done', deadline: '2026-08-01' }),
	];

	assert.deepEqual(
		sortTasks(tasks, categoryPositions, 'priority').map((task) => task.id),
		['beta', 'alpha-first', 'alpha-late', 'done'],
	);

	const deadlineTasks = [
		makeTask({ id: 'alpha-late', name: 'Late', category: 'Alpha', priority_position: 0, deadline: '2026-08-12', deadline_time: '12:00' }),
		makeTask({ id: 'alpha-early', name: 'Early', category: 'Alpha', priority_position: 1, deadline: '2026-08-12', deadline_time: '08:00' }),
		makeTask({ id: 'beta', name: 'Beta task', category: 'Beta', priority_position: 0, deadline: '2026-08-13' }),
	];
	assert.deepEqual(
		sortTasks(deadlineTasks, categoryPositions, 'deadline').map((task) => task.id),
		['beta', 'alpha-early', 'alpha-late'],
	);
});

test('task and category payloads normalize values and reject malformed reorder requests', () => {
	const taskId = '11111111-1111-4111-8111-111111111111';
	const otherTaskId = '22222222-2222-4222-8222-222222222222';
	const category = parseTaskReorderPayload({
		type: 'category',
		category: '  Alpha ',
		taskIds: [taskId, otherTaskId],
	});
	assert.deepEqual(category, {
		value: { type: 'category', category: 'Alpha', taskIds: [taskId, otherTaskId] },
	});

	const move = parseTaskReorderPayload({
		type: 'move',
		taskId: taskId,
		sourceCategory: ' Alpha ',
		destinationCategory: 'Beta',
		sourceTaskIds: [otherTaskId],
		destinationTaskIds: [taskId],
	});
	assert.equal('error' in move, false);
	if ('value' in move && move.value.type === 'move') {
		assert.equal(move.value.sourceCategory, 'Alpha');
		assert.equal(move.value.destinationCategory, 'Beta');
	}

	assert.deepEqual(
		parseTaskReorderPayload({ type: 'category', category: 'Alpha', taskIds: [taskId, taskId] }),
		{ error: 'taskIds contains duplicate task IDs' },
	);
	assert.deepEqual(parseCategoryReorderPayload({ categoryNames: ['Alpha', 'Alpha'] }), {
		error: 'categoryNames contains duplicate categories',
	});
	assert.deepEqual(expectedRpcErrorResponse('forbidden: editor role required'), { message: 'Forbidden', status: 403 });
});

test('only owners and editors can change priority, and filtered/deadline/done rows cannot drag', () => {
	assert.equal(canEditTasks('owner'), true);
	assert.equal(canEditTasks('editor'), true);
	assert.equal(canEditTasks('viewer'), false);
	assert.equal(canEditTasks(null), false);

	const task = makeTask({ status: 'ongoing' });
	const access = { canEdit: true, onlyMine: false, sortMode: 'priority' as const, pending: false };
	assert.equal(canReorderTask(task, access), true);
	assert.equal(canReorderTask(task, { ...access, onlyMine: true }), false);
	assert.equal(canReorderTask(task, { ...access, sortMode: 'deadline' }), false);
	assert.equal(canReorderTask(task, { ...access, pending: true }), false);
	assert.equal(canReorderTask({ status: 'done' }, access), false);
	assert.equal(canReorderTask(task, { ...access, canEdit: false }), false);
});

test('reminders preserve deadline buckets and sort each bucket by category and local priority', () => {
	const tasks = [
		makeTask({ id: 'alpha-low', category: 'Alpha', priority_position: 3, deadline: '2026-08-12' }),
		makeTask({ id: 'beta', category: 'Beta', priority_position: 0, deadline: '2026-08-12' }),
		makeTask({ id: 'alpha-high', category: 'Alpha', priority_position: 1, deadline: '2026-08-12' }),
		makeTask({ id: 'no-deadline', deadline: null }),
	];
	const reminders = projectReminders(tasks, 'project-1', {}, 'user-1', categoryPositions);
	assert.deepEqual(reminders.map((reminder) => reminder.id), ['beta', 'alpha-high', 'alpha-low']);
	assert.equal(reminders.every((reminder) => reminder.deadline !== null), true);

	const mixed = [
		{ ...reminders[2], id: 'z' },
		{ ...reminders[0], id: 'a' },
	];
	assert.deepEqual(sortReminders(mixed).map((reminder) => reminder.id), ['a', 'z']);
});

test('exports include category/task priority and always emit priority order', () => {
	const payload = buildTaskExportPayload(
		'Project',
		'2026-08-09T00:00:00.000Z',
		[
			makeTask({ id: 'alpha', category: 'Alpha', priority_position: 0, assignees: [{ id: 'a', user_id: 'u', ghost_member_id: null, display_name: 'Alice', avatar: null }] }),
			makeTask({ id: 'beta', category: 'Beta', priority_position: 0 }),
		],
		categoryPositions,
	);

	assert.equal(payload.taskCount, 2);
	assert.deepEqual(payload.tasks.map((task) => task.id), ['beta', 'alpha']);
	assert.equal(payload.tasks[0].priorityPosition, 0);
	assert.deepEqual(payload.categoryPositions, [
		{ category: 'Beta', priorityPosition: 0 },
		{ category: 'Alpha', priorityPosition: 1 },
	]);
	assert.deepEqual(payload.tasks[1].assignees, ['Alice']);
});

test('optimistic task/category reorders persist, move across categories, place new tasks, and roll back failures', async () => {
	const stateModule = await loadTasksStore();
	const { initTasks, addTask, reorderTasksInCategory, moveTaskToCategory, reorderTaskCategories, taskReorderState, tasksState } = stateModule;
	const originalFetch = globalThis.fetch;
	const alphaOne = makeTask({ id: 'alpha-one', category: 'Alpha', priority_position: 0 });
	const alphaTwo = makeTask({ id: 'alpha-two', category: 'Alpha', priority_position: 1 });
	const betaOne = makeTask({ id: 'beta-one', category: 'Beta', priority_position: 0 });

	try {
		initTasks([alphaOne, alphaTwo, betaOne], categoryPositions, 'priority');
		globalThis.fetch = async () =>
			new Response(JSON.stringify({ ok: true, type: 'category', orders: [{ category: 'Alpha', taskIds: ['alpha-two', 'alpha-one'] }] }), { status: 200 });
		assert.deepEqual(await reorderTasksInCategory('project-1', 'Alpha', ['alpha-two', 'alpha-one']), { ok: true });
		assert.deepEqual(tasksState.tasks.filter((task) => task.category === 'Alpha').map((task) => task.id), ['alpha-two', 'alpha-one']);

		globalThis.fetch = async () =>
			new Response(JSON.stringify({ ok: true, type: 'move', taskId: 'alpha-one', orders: [
				{ category: 'Alpha', taskIds: ['alpha-two'] },
				{ category: 'Beta', taskIds: ['beta-one', 'alpha-one'] },
			] }), { status: 200 });
		assert.deepEqual(
			await moveTaskToCategory('project-1', 'alpha-one', 'Alpha', 'Beta', ['alpha-two'], ['beta-one', 'alpha-one']),
			{ ok: true },
		);
		assert.equal(tasksState.tasks.find((task) => task.id === 'alpha-one')?.category, 'Beta');

		globalThis.fetch = async () =>
			new Response(JSON.stringify({ ok: true, categoryNames: ['Alpha', 'Beta'], categoryPositions: [
				{ id: 'category-alpha', categoryName: 'Alpha', priorityPosition: 0 },
				{ id: 'category-beta', categoryName: 'Beta', priorityPosition: 1 },
			] }), { status: 200 });
		assert.deepEqual(await reorderTaskCategories('project-1', ['Alpha', 'Beta']), { ok: true });
		assert.deepEqual(tasksState.categoryPositions.map((position) => position.category_name), ['Alpha', 'Beta']);

		addTask(makeTask({ id: 'new-alpha', category: 'Alpha', priority_position: 2 }));
		assert.deepEqual(tasksState.tasks.filter((task) => task.category === 'Alpha').map((task) => task.id), ['alpha-two', 'new-alpha']);

		const beforeFailure = tasksState.tasks.map((task) => ({ id: task.id, category: task.category, priority: task.priority_position }));
		globalThis.fetch = async () => new Response('network failed', { status: 503 });
		const failure = await reorderTasksInCategory('project-1', 'Alpha', ['new-alpha', 'alpha-two']);
		assert.deepEqual(failure, { ok: false, error: 'network failed' });
		assert.deepEqual(tasksState.tasks.map((task) => ({ id: task.id, category: task.category, priority: task.priority_position })), beforeFailure);
		assert.deepEqual(taskReorderState.error, { scope: 'category', category: 'Alpha', message: 'network failed' });

		initTasks([makeTask({ id: 'done', category: 'Alpha', status: 'done' })], categoryPositions, 'priority');
		const completed = await reorderTasksInCategory('project-1', 'Alpha', ['done']);
		assert.deepEqual(completed, { ok: false, error: 'Invalid task order' });
		assert.deepEqual(taskReorderState.error, { scope: 'category', category: 'Alpha', message: 'Invalid task order' });
	} finally {
		globalThis.fetch = originalFetch;
	}
});

type TasksStoreModule = typeof import('../src/lib/tasks-store.svelte.ts');
let tasksStorePromise: Promise<TasksStoreModule> | null = null;

async function loadTasksStore(): Promise<TasksStoreModule> {
	if (!tasksStorePromise) {
		const nodeGlobals = globalThis as unknown as { $state: <T>(value: T) => T };
		nodeGlobals.$state = <T>(value: T) => value;
		tasksStorePromise = import('../src/lib/tasks-store.svelte.ts');
	}
	return tasksStorePromise;
}
