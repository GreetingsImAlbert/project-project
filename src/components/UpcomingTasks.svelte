<script lang="ts">
	import { onMount } from 'svelte';
	import { categoryColorStyle } from '../lib/category-color';
	import { daysUntil, localToday, relativeDeadline } from '../lib/task-status';
	import { HORIZON_COOKIE, HORIZON_OPTIONS, horizonLabel } from '../lib/task-horizon';
	import type { Reminder } from '../lib/reminders';

	let {
		reminders,
		initialHorizonDays,
		serverToday,
		showMineFilter = false,
		emptyLabel = 'Nothing due',
	}: {
		// Already narrowed by the page's query to tasks that aren't done and do have a
		// deadline — everything else can never be a reminder.
		reminders: Reminder[];
		initialHorizonDays: number;
		serverToday: string;
		// The Overview offers it; the Dashboard doesn't, because its list is the reader's
		// own tasks to begin with and the filter would be a checkbox that changes nothing.
		showMineFilter?: boolean;
		emptyLabel?: string;
	} = $props();

	// Server's date first so SSR and hydration agree on which tasks fall inside the
	// window, then the reader's own calendar day once mounted — see task-status.ts.
	let today = $state(serverToday);

	onMount(() => {
		today = localToday();
	});

	// Not a store: neither page that renders this edits tasks, so there's no second
	// island whose copy could go stale.
	let horizonDays = $state(initialHorizonDays);

	function setHorizon(days: number) {
		horizonDays = days;
		localStorage.setItem(HORIZON_COOKIE, String(days));
		document.cookie = `${HORIZON_COOKIE}=${days}; path=/; max-age=31536000; samesite=lax`;
	}

	// Same filter as the Tasks list's, and deliberately not persisted for the same
	// reason that one isn't: it's a way to read the list right now, not a setting.
	let onlyMine = $state(false);

	let scoped = $derived(showMineFilter && onlyMine ? reminders.filter((r) => r.mine) : reminders);

	// Anything already past due, however long ago. Deliberately not bounded by the
	// horizon: the setting says how far ahead to look, and a deadline that has already
	// been missed is the one reminder nobody should be able to shorten their way out of.
	let overdue = $derived(scoped.filter((r) => r.deadline < today));

	let upcoming = $derived(
		scoped.filter((r) => r.deadline >= today && daysUntil(r.deadline, today) <= horizonDays),
	);

	// Both halves in one list, overdue first — the section is a reading order, not two
	// separate lists, and the rows already say which is which.
	let due = $derived([...overdue, ...upcoming]);
</script>

<section class="reminders">
	<div class="reminders-head">
		<h2>Reminders</h2>
		<span class="reminders-meta">
			{#if due.length === 0}
				nothing due
			{:else}
				<strong>{due.length}</strong> due{overdue.length > 0 ? `, ${overdue.length} overdue` : ''}
			{/if}
		</span>

		{#if showMineFilter}
			<label class="mine-toggle">
				<input type="checkbox" bind:checked={onlyMine} />
				<span>Just my tasks</span>
			</label>
		{/if}

		<label class="horizon">
			Looking ahead
			<select value={horizonDays} onchange={(e) => setHorizon(Number(e.currentTarget.value))}>
				{#each HORIZON_OPTIONS as days (days)}
					<option value={days}>{horizonLabel(days)}</option>
				{/each}
			</select>
		</label>
	</div>

	{#if due.length === 0}
		<p class="muted empty">{emptyLabel} in the {horizonLabel(horizonDays)}.</p>
	{:else}
		<ul class="reminder-list">
			{#each due as reminder (reminder.id)}
				{@const late = reminder.deadline < today}
				<li class="reminder" class:late style={categoryColorStyle(reminder.colorIndex)}>
					<span class="band" aria-hidden="true"></span>
					<div class="reminder-main">
						<!-- Straight to the task, not just to the page it lives on: the hash is what
						     TasksTable reads on mount to open that task's detail panel. -->
						<a class="reminder-name" href={`/projects/${reminder.projectId}/tasks#task-${reminder.id}`}>
							{reminder.name}
						</a>
						<span class="reminder-sub">
							{#if reminder.projectName}{reminder.projectName} · {/if}
							{reminder.category?.trim() || 'Uncategorized'}
							{#if reminder.assignees}· {reminder.assignees}{/if}
						</span>
					</div>
					<div class="reminder-when">
						<span class="reminder-date">{reminder.deadline}</span>
						<span class="reminder-rel">{late ? 'overdue' : ''} {relativeDeadline(reminder.deadline, today)}</span>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.reminders {
		margin-top: var(--space-5);
	}

	/* Same reason TasksTable's head zeroes these: global.css's heading rules can't be
	   reached through the astro-island wrapper with :global(), so an island's first
	   heading undoes the divider styling itself. */
	.reminders-head {
		display: flex;
		align-items: baseline;
		gap: var(--space-3);
		flex-wrap: wrap;
		margin-bottom: var(--space-3);
	}

	.reminders-head h2 {
		margin: 0;
		padding-top: 0;
		border-top: none;
	}

	.reminders-meta {
		font-size: 0.78rem;
		color: var(--color-muted);
		white-space: nowrap;
	}

	.reminders-meta strong {
		color: var(--color-fg);
		font-variant-numeric: tabular-nums;
	}

	/* The filter carries the margin that pushes the right-hand controls over, as it does
	   on the Tasks page — but the horizon has to keep one of its own for the Dashboard,
	   where there's no filter to do it. */
	.mine-toggle {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		margin-left: auto;
		font-size: 0.78rem;
		color: var(--color-muted);
		white-space: nowrap;
		cursor: pointer;
	}

	.mine-toggle input {
		margin: 0;
		cursor: pointer;
	}

	.horizon {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		margin-left: auto;
		font-size: 0.78rem;
		color: var(--color-muted);
		white-space: nowrap;
	}

	.mine-toggle ~ .horizon {
		margin-left: 0;
	}

	.horizon select {
		font-size: 0.78rem;
		padding: var(--space-1) var(--space-2);
	}

	.empty {
		font-size: 0.85rem;
	}

	.reminder-list {
		list-style: none;
		margin: 0;
		padding: 0;
		border-top: 1px solid var(--color-border);
	}

	.reminder {
		display: flex;
		align-items: baseline;
		gap: var(--space-3);
		padding: var(--space-2) 0;
		border-bottom: 1px solid var(--color-border);
	}

	/* The category's colour, in the same slot the list's group bands use — a stripe
	   rather than a filled row, since a reminder has to stay readable next to the
	   description text beside it. Uncategorized tasks get the neutral border colour,
	   because categoryColorStyle returns '' and the var falls back. */
	.band {
		flex: 0 0 3px;
		align-self: stretch;
		border-radius: 2px;
		background: var(--cat-bg, var(--color-border));
	}

	.reminder-main {
		display: flex;
		flex-direction: column;
		gap: 2px;
		flex: 1 1 auto;
		min-width: 0;
	}

	.reminder-name {
		font-size: 0.9rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.reminder-sub {
		font-size: 0.72rem;
		color: var(--color-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.reminder-when {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 2px;
		flex: 0 0 auto;
		text-align: right;
	}

	.reminder-date {
		font-size: 0.8rem;
		font-variant-numeric: tabular-nums;
	}

	.reminder-rel {
		font-size: 0.72rem;
		color: var(--color-muted);
	}

	.reminder.late .reminder-date,
	.reminder.late .reminder-rel {
		color: var(--color-danger);
	}
</style>
