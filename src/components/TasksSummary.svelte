<script lang="ts">
	import { onMount } from 'svelte';
	import { tasksState, initTasks, type Task } from '../lib/tasks-store.svelte';
	import { displayStatus, localToday, relativeDeadline } from '../lib/task-status';

	let {
		initialTasks,
		serverToday,
	}: {
		initialTasks: Task[];
		serverToday: string;
	} = $props();

	initTasks(initialTasks);

	// Starts on the server's date so SSR and hydration agree, then moves to the
	// reader's own calendar day once mounted — see task-status.ts.
	let today = $state(serverToday);

	onMount(() => {
		today = localToday();
	});

	let statuses = $derived(tasksState.tasks.map((task) => displayStatus(task, today)));

	let ongoing = $derived(statuses.filter((s) => s === 'ongoing').length);
	let overdue = $derived(statuses.filter((s) => s === 'overdue').length);
	let done = $derived(statuses.filter((s) => s === 'done').length);
	let total = $derived(tasksState.tasks.length);

	let percentDone = $derived(total === 0 ? 0 : Math.round((done / total) * 100));

	// Soonest deadline still ahead of us on a task that isn't done. Overdue tasks are
	// excluded on purpose — they have their own tile, and showing a past date under
	// 'Next deadline' would read as if it were still upcoming.
	let nextDue = $derived(
		tasksState.tasks
			.filter((task) => task.status !== 'done' && task.deadline && task.deadline >= today)
			.map((task) => task.deadline!)
			.sort()[0] ?? null,
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
		<span class="tile-label">Done</span>
		<span class="tile-value">{done}</span>
		<span class="tile-note">{percentDone}% complete</span>
	</div>

	<div class="tile">
		<span class="tile-label">Next deadline</span>
		<span class="tile-value">{nextDue ?? '—'}</span>
		<span class="tile-note">{nextDue ? relativeDeadline(nextDue, today) : 'nothing scheduled'}</span>
	</div>
</div>

<style>
	.summary {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 0;
		border: 1px solid var(--color-border-strong);
		margin-bottom: var(--space-2);
	}

	.tile {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		padding: var(--space-3);
		border-right: 1px solid var(--color-border);
	}

	.tile:last-child {
		border-right: none;
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
		font-size: 1.15rem;
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
			grid-template-columns: repeat(2, 1fr);
		}

		.tile:nth-child(2n) {
			border-right: none;
		}

		.tile:nth-child(n + 3) {
			border-top: 1px solid var(--color-border);
		}
	}

	@media (max-width: 480px) {
		.summary {
			grid-template-columns: 1fr;
		}

		.tile {
			border-right: none;
		}

		.tile:not(:first-child) {
			border-top: 1px solid var(--color-border);
		}
	}
</style>
