<script lang="ts">
	import { tasksState, initTasks, type Task } from '../lib/tasks-store.svelte';
	import { deadlinePassed, displayStatus, relativeDeadline } from '../lib/task-status';
	import { formatDeadlineTime } from '../lib/deadline-time';

	let {
		initialTasks,
		serverToday,
		serverNowTime,
	}: {
		initialTasks: Task[];
		serverToday: string;
		serverNowTime: string;
	} = $props();

	initTasks(initialTasks);

	// Rendered on the server and reused as-is: it's an Asia/Manila date either way,
	// so there's nothing for the client to correct — see today.ts.
	const today = serverToday;
	const nowTime = serverNowTime;

	let statuses = $derived(tasksState.tasks.map((task) => displayStatus(task, today, nowTime)));

	let ongoing = $derived(statuses.filter((s) => s === 'ongoing').length);
	let overdue = $derived(statuses.filter((s) => s === 'overdue').length);
	let total = $derived(tasksState.tasks.length);

	// Soonest deadline still ahead of us on a task that isn't done. Overdue tasks are
	// excluded on purpose — they have their own tile, and showing a past date under
	// 'Next deadline' would read as if it were still upcoming. The whole moment is kept
	// rather than just the date, so the note underneath can say the time of day and two
	// tasks sharing a date resolve to the earlier one.
	let nextDue = $derived(
		tasksState.tasks
			.filter(
				(task) =>
					task.status !== 'done' &&
					task.deadline &&
					!deadlinePassed(task.deadline, task.deadline_time, today, nowTime),
			)
			.map((task) => ({ date: task.deadline!, time: task.deadline_time }))
			.sort((a, b) => (a.date === b.date ? a.time.localeCompare(b.time) : a.date.localeCompare(b.date)))[0] ?? null,
	);
</script>

<div class="summary">
	<div class="tile">
		<span class="tile-label">Ongoing</span>
		<span class="tile-value">{ongoing}</span>
		<span class="tile-note">of {total} task{total === 1 ? '' : 's'}</span>
	</div>

	<div class="tile" class:alert={overdue > 0}>
		<span class="tile-label">Overdue</span>
		<span class="tile-value">{overdue}</span>
		<span class="tile-note">{overdue === 0 ? 'nothing past due' : 'past their deadline'}</span>
	</div>

	<div class="tile">
		<span class="tile-label">Next deadline</span>
		<span class="tile-value">{nextDue?.date ?? '—'}</span>
		<span class="tile-note">
			{nextDue ? `${relativeDeadline(nextDue.date, today)} · ${formatDeadlineTime(nextDue.time)}` : 'nothing scheduled'}
		</span>
	</div>
</div>

<style>
	/* No box and no cell rules: the Tasks page reads as an open list, so the figures
	   above it are laid out on the same open space and only the hairline underneath
	   separates them from it. */
	.summary {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--space-5);
		padding-bottom: var(--space-4);
		border-bottom: 1px solid var(--color-border);
	}

	.tile {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.tile-label {
		color: var(--color-muted);
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.tile-value {
		font-size: 1.35rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		line-height: 1.3;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.tile-note {
		color: var(--color-muted);
		font-size: 0.7rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.tile.alert .tile-value,
	.tile.alert .tile-label {
		color: var(--color-danger);
	}

	@media (max-width: 900px) {
		.summary {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: var(--space-4) var(--space-5);
		}
	}

	@media (max-width: 480px) {
		.summary {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.tile-value {
			font-size: 1.15rem;
		}
	}
</style>
