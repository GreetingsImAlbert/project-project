<script lang="ts">
	import { categoryColorStyle } from '../lib/category-color';
	import { daysUntil, formatDeadline, relativeDeadline } from '../lib/task-status';
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

	// Which tasks fall inside the window is decided once, on the server: it's an
	// Asia/Manila date there and would be the same one here — see today.ts.
	const today = serverToday;

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
				<!-- One line per reminder: the name, the context it belongs to, then the date
				     and how far off it is. The stacked version said the same things in twice
				     the height, and this list is read at a glance. -->
				<li class="reminder" class:late style={categoryColorStyle(reminder.colorIndex)}>
					<span class="band" aria-hidden="true"></span>
					<!-- Straight to the task, not just to the page it lives on: the hash is what
					     TasksTable reads on mount to open that task's detail panel. The link is
					     still just the title — the CSS stretches its hit area over the whole row,
					     so the row is clickable without a second, mouse-only click handler. -->
					<a class="reminder-name" href={`/projects/${reminder.projectId}/tasks#task-${reminder.id}`}>
						{reminder.name}
					</a>
					<span class="reminder-sub">
						{#if reminder.projectName}{reminder.projectName} · {/if}
						{reminder.category?.trim() || 'Uncategorized'}
						{#if reminder.assignees}· {reminder.assignees}{/if}
					</span>
					<span class="reminder-date">{formatDeadline(reminder.deadline, today)}</span>
					<span class="reminder-rel">{late ? 'overdue' : ''} {relativeDeadline(reminder.deadline, today)}</span>
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

	/* Both centred in the head rather than baseline-aligned with it. An inline-flex box
	   takes its baseline from its first item, and the toggle's first item is a checkbox
	   — which has none, so the box sat on the checkbox's bottom edge and 'Just my tasks'
	   rode low against 'Looking ahead' beside it. Centring the pair lines the two labels
	   up with each other, which is the alignment that's actually being read. */
	.mine-toggle,
	.horizon {
		align-self: center;
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

	/* Padded on the sides like a TasksTable row, so the hover fill has an edge to sit
	   inside rather than running flush against the text. `position: relative` is what
	   the title's stretched hit area resolves against. */
	.reminder {
		position: relative;
		display: flex;
		align-items: baseline;
		gap: var(--space-3);
		padding: var(--space-2);
		border-bottom: 1px solid var(--color-border);
		line-height: 1.35;
		transition: background 0.12s ease;
	}

	/* focus-within as well as hover: reaching the link by keyboard should light the same
	   row the pointer would. */
	.reminder:hover,
	.reminder:focus-within {
		background: var(--color-highlight);
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

	/* Sized to its text, not to the row: global.css underlines a link on hover with a
	   border, and a full-width anchor would draw that rule clear across the row. The
	   whole row is still a click target — see the stretched pseudo-element below. */
	.reminder-name {
		flex: 0 1 auto;
		min-width: 0;
		font-size: 0.9rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* The row's hit area, laid over it by the one link it contains. A real anchor rather
	   than a click handler on the <li>: middle-click, ctrl-click and the keyboard all
	   keep working, and there's nothing to keep in sync with the href. */
	.reminder-name::after {
		content: '';
		position: absolute;
		inset: 0;
	}

	/* Hovering anywhere on the row underlines the title — the row is the target, but the
	   title is what says where it goes. */
	.reminder:hover .reminder-name {
		border-bottom-color: currentColor;
	}

	/* `flex: 1 1 0` rather than `auto`: the context line takes the leftover space and
	   gives it back first, so a long project or category name truncates before the task
	   name it belongs to does. */
	.reminder-sub {
		flex: 1 1 0;
		min-width: 0;
		font-size: 0.72rem;
		color: var(--color-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.reminder-date {
		flex: 0 0 auto;
		margin-left: auto;
		font-size: 0.8rem;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.reminder-rel {
		flex: 0 0 auto;
		font-size: 0.72rem;
		color: var(--color-muted);
		white-space: nowrap;
	}

	.reminder.late .reminder-date,
	.reminder.late .reminder-rel {
		color: var(--color-danger);
	}

	/* Narrow enough that four things can't share a line: the context drops out rather
	   than squeezing the name and the date into slivers, and the detail panel behind
	   the link has all of it anyway. */
	@media (max-width: 560px) {
		.reminder-sub {
			display: none;
		}
	}
</style>
