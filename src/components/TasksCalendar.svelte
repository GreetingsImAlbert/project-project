<script lang="ts">
	import type { Task } from '../lib/tasks-store.svelte';
	import { displayStatus } from '../lib/task-status';

	// A child of TasksTable rather than its own island: it reads the same filtered
	// task list, the same `today`, and the same category colours, and clicking a
	// popsicle opens the panel TasksTable already owns. Passing all of that through
	// props keeps one component in charge of the page's state.
	let {
		tasks,
		today,
		colorFor,
		onSelect,
		selectedId,
	}: {
		tasks: Task[];
		today: string;
		colorFor: (task: Task) => string;
		onSelect: (id: string) => void;
		selectedId: string | null;
	} = $props();

	// Hardcoded rather than Intl.DateTimeFormat: this renders during SSR on a Worker
	// and again during hydration in the browser, and the two don't necessarily resolve
	// the same locale — a mismatch here would be a month name that changes on hydrate.
	const MONTH_NAMES = [
		'January',
		'February',
		'March',
		'April',
		'May',
		'June',
		'July',
		'August',
		'September',
		'October',
		'November',
		'December',
	];
	const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

	// An offset from `today`'s month rather than a stored year/month, so the grid
	// follows when the parent moves `today` from the server's date to the reader's own
	// on mount (see task-status.ts) instead of being pinned to whichever it saw first.
	let monthOffset = $state(0);

	let view = $derived.by(() => {
		const [year, month] = today.split('-').map(Number);
		const anchor = new Date(Date.UTC(year, month - 1 + monthOffset, 1));
		return { year: anchor.getUTCFullYear(), month: anchor.getUTCMonth() };
	});

	// Every date here is built and read in UTC. The dates themselves are plain calendar
	// days (`deadline` is a `date` column, not a timestamp), so keeping the arithmetic
	// off local time is what stops a day being dropped or doubled across a DST shift.
	let byDate = $derived.by(() => {
		const map = new Map<string, Task[]>();
		for (const task of tasks) {
			if (!task.deadline) continue;
			if (!map.has(task.deadline)) map.set(task.deadline, []);
			map.get(task.deadline)!.push(task);
		}
		return map;
	});

	let undated = $derived(tasks.filter((task) => !task.deadline).length);

	let cells = $derived.by(() => {
		const first = new Date(Date.UTC(view.year, view.month, 1));
		const lead = first.getUTCDay();
		// Day 0 of the next month is the last day of this one.
		const daysInMonth = new Date(Date.UTC(view.year, view.month + 1, 0)).getUTCDate();
		const total = Math.ceil((lead + daysInMonth) / 7) * 7;

		return Array.from({ length: total }, (_, i) => {
			const date = new Date(Date.UTC(view.year, view.month, 1 - lead + i));
			const iso = date.toISOString().slice(0, 10);
			return {
				iso,
				day: date.getUTCDate(),
				weekday: WEEKDAYS[date.getUTCDay()],
				month: MONTH_NAMES[date.getUTCMonth()].slice(0, 3),
				inMonth: date.getUTCMonth() === view.month,
				tasks: byDate.get(iso) ?? [],
			};
		});
	});

	let monthTaskCount = $derived(cells.reduce((sum, cell) => sum + (cell.inMonth ? cell.tasks.length : 0), 0));
</script>

<div class="calendar">
	<div class="cal-head">
		<button type="button" class="btn-plain nav" aria-label="Previous month" onclick={() => monthOffset--}>‹</button>
		<span class="cal-title">{MONTH_NAMES[view.month]} {view.year}</span>
		<button type="button" class="btn-plain nav" aria-label="Next month" onclick={() => monthOffset++}>›</button>

		{#if monthOffset !== 0}
			<button type="button" class="btn-plain today-btn" onclick={() => (monthOffset = 0)}>Today</button>
		{/if}

		<span class="cal-meta">
			{monthTaskCount} due this month{undated > 0 ? ` · ${undated} undated` : ''}
		</span>
	</div>

	<!-- Weekday band and empty cells both disappear below 700px, where the grid becomes
	     a single column and reads as an agenda of the days that actually have work on
	     them — seven columns of popsicle titles is unreadable on a phone. -->
	<div class="weekdays" aria-hidden="true">
		{#each WEEKDAYS as label (label)}
			<span>{label}</span>
		{/each}
	</div>

	<div class="grid">
		{#each cells as cell (cell.iso)}
			<div
				class="day"
				class:outside={!cell.inMonth}
				class:is-today={cell.iso === today}
				class:is-empty={cell.tasks.length === 0}
			>
				<div class="day-label">
					<span class="day-num">{cell.day}</span>
					<span class="day-full">{cell.weekday} {cell.month} {cell.day}</span>
				</div>

				<div class="pops">
					{#each cell.tasks as task (task.id)}
						{@const status = displayStatus(task, today)}
						<!-- The popsicle carries the category colour and nothing else, so status
						     has to be said another way: done is struck through and faded, overdue
						     takes a danger-coloured edge. -->
						<button
							type="button"
							class="pop status-{status}"
							class:selected={selectedId === task.id}
							style={colorFor(task)}
							title={task.name}
							onclick={() => onSelect(task.id)}
						>
							{task.name}
						</button>
					{/each}
				</div>
			</div>
		{/each}
	</div>
</div>

<style>
	.calendar {
		border-top: 1px solid var(--color-border);
	}

	.cal-head {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-3) var(--space-2);
	}

	.cal-title {
		font-size: 0.85rem;
		font-weight: 700;
		letter-spacing: 0.03em;
		white-space: nowrap;
	}

	.nav {
		padding: 0 var(--space-2);
		font-size: 1rem;
		line-height: 1.4;
	}

	.today-btn {
		padding: 0 var(--space-2);
		font-size: 0.7rem;
		line-height: 1.8;
	}

	.cal-meta {
		margin-left: auto;
		color: var(--color-muted);
		font-size: 0.72rem;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.weekdays,
	.grid {
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
	}

	.weekdays {
		border-top: 1px solid var(--color-border);
		border-bottom: 1px solid var(--color-border);
	}

	.weekdays span {
		padding: var(--space-2);
		color: var(--color-muted);
		font-size: 0.64rem;
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		text-align: center;
	}

	/* One hairline per cell rather than a border on the container: the grid is ruled
	   like a month, which is the one place on the Tasks page a real grid is honest —
	   the days are a fixed shape, unlike the task rows. */
	.day {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		min-height: 96px;
		min-width: 0;
		padding: var(--space-1);
		border-right: 1px solid var(--color-border);
		border-bottom: 1px solid var(--color-border);
	}

	.day:nth-child(7n) {
		border-right: none;
	}

	.day.outside {
		background: var(--color-highlight);
	}

	.day.outside .day-label {
		opacity: 0.5;
	}

	.day-label {
		display: flex;
		align-items: baseline;
		gap: var(--space-1);
		font-size: 0.7rem;
		font-variant-numeric: tabular-nums;
		color: var(--color-muted);
	}

	.day-full {
		display: none;
	}

	.day.is-today .day-label {
		color: var(--color-fg);
		font-weight: 700;
	}

	.day.is-today .day-num {
		background: var(--color-fg);
		color: var(--color-bg);
		padding: 0 var(--space-1);
	}

	.pops {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	/* The popsicle: a full-width chip filled with its category's colour, falling back
	   to the neutral surface when the task has no category at all (categoryColorStyle
	   returns '' for those, so the var() fallback is the whole uncategorized path). */
	.pop {
		display: block;
		width: 100%;
		min-width: 0;
		padding: 1px var(--space-1);
		border: none;
		border-left: 3px solid transparent;
		background: var(--cat-bg, var(--color-border));
		color: var(--cat-fg, var(--color-fg));
		font: inherit;
		font-size: 0.68rem;
		line-height: 1.5;
		text-align: left;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		cursor: pointer;
	}

	.pop:hover {
		opacity: 0.8;
	}

	.pop.status-done {
		text-decoration: line-through;
		opacity: 0.55;
	}

	.pop.status-overdue {
		border-left-color: var(--color-danger);
	}

	.pop.selected {
		outline: 2px solid var(--color-border-strong);
		outline-offset: -2px;
	}

	/* Seven columns of truncated titles are unreadable on a phone, so the month folds
	   into an agenda: one full-width row per day that has something due, empty days
	   dropped entirely and each remaining day labelled with its full date instead of a
	   bare number. Same markup, no second render path. */
	@media (max-width: 700px) {
		.weekdays {
			display: none;
		}

		.grid {
			grid-template-columns: minmax(0, 1fr);
			border-top: 1px solid var(--color-border);
		}

		.day.is-empty {
			display: none;
		}

		.day {
			border-right: none;
			min-height: 0;
			padding: var(--space-2) var(--space-1);
		}

		.day.outside {
			background: none;
		}

		.day-num {
			display: none;
		}

		.day-full {
			display: inline;
		}

		.day.is-today .day-label::after {
			content: 'today';
			color: var(--color-muted);
			font-weight: 400;
		}

		.pop {
			font-size: 0.76rem;
			padding: var(--space-1);
		}
	}
</style>
