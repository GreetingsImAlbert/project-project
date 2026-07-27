<script lang="ts">
	import { onMount } from 'svelte';
	import { slide } from 'svelte/transition';
	import { tasksState, initTasks, addTask, updateTask, removeTask, type Task } from '../lib/tasks-store.svelte';
	import {
		displayStatus,
		localToday,
		relativeDeadline,
		TASK_STATUS_LABELS,
		type TaskDisplayStatus,
	} from '../lib/task-status';

	let {
		projectId,
		initialTasks,
		members,
		canEdit,
		currentUserId,
		serverToday,
	}: {
		projectId: string;
		initialTasks: Task[];
		members: { id: string; displayName: string }[];
		canEdit: boolean;
		currentUserId: string;
		serverToday: string;
	} = $props();

	initTasks(initialTasks);

	// Server's date first so SSR and hydration render the same statuses, then the
	// reader's own calendar day once mounted — see task-status.ts.
	let today = $state(serverToday);

	onMount(() => {
		today = localToday();
	});

	// One panel is open at a time: either a task's read-only detail or its edit form.
	let openId = $state<string | null>(null);
	let openMode = $state<'detail' | 'edit'>('detail');

	let savingId = $state<string | null>(null);
	let deletingId = $state<string | null>(null);
	let togglingId = $state<string | null>(null);
	let rowError = $state<{ id: string; message: string } | null>(null);

	let adding = $state(false);
	let addError = $state<string | null>(null);
	let showAddForm = $state(false);
	let addName = $state('');
	let addCategorySelect = $state('');
	let addCategoryNew = $state('');
	let addDescription = $state('');
	let addDeadline = $state('');
	let addStatus = $state<'ongoing' | 'done'>('ongoing');
	let addAssignees = $state<string[]>([]);

	let editCategorySelect = $state('');
	let editCategoryNew = $state('');
	let editAssignees = $state<string[]>([]);

	const NEW_CATEGORY_VALUE = '__new__';
	const UNCATEGORIZED = 'Uncategorized';

	// Same derivation as BomTable's: the dropdown offers whatever categories the
	// current tasks already use, so the backend still only ever stores free text.
	// Derived from every task, not the visible ones — a filter that hides a category
	// shouldn't take it out of the dropdown.
	let existingCategories = $derived(
		[...new Set(tasksState.tasks.map((task) => task.category?.trim()).filter((c): c is string => !!c))].sort((a, b) =>
			a.localeCompare(b),
		),
	);

	let addCategoryEffective = $derived(addCategorySelect === NEW_CATEGORY_VALUE ? addCategoryNew : addCategorySelect);
	let editCategoryEffective = $derived(editCategorySelect === NEW_CATEGORY_VALUE ? editCategoryNew : editCategorySelect);

	let onlyMine = $state(false);

	let visibleTasks = $derived(
		onlyMine
			? tasksState.tasks.filter((task) => task.assignees.some((a) => a.user_id === currentUserId))
			: tasksState.tasks,
	);

	// Same grouping as BomTable's, including 'Uncategorized' sorting last rather than
	// alphabetically. Tasks keep their deadline order inside a group, since the store
	// sorts the whole list and this only partitions it.
	let groups = $derived.by(() => {
		const map = new Map<string, Task[]>();
		for (const task of visibleTasks) {
			const key = task.category?.trim() || UNCATEGORIZED;
			if (!map.has(key)) map.set(key, []);
			map.get(key)!.push(task);
		}
		const keys = [...map.keys()].sort((a, b) => {
			if (a === UNCATEGORIZED) return 1;
			if (b === UNCATEGORIZED) return -1;
			return a.localeCompare(b);
		});
		return keys.map((category) => ({ category, tasks: map.get(category)! }));
	});

	// Nothing to fold when every task is uncategorized: the one band would say
	// 'Uncategorized' over the whole list and fold it away entirely.
	let showGroupHeaders = $derived(groups.length > 1 || groups[0]?.category !== UNCATEGORIZED);

	// A plain array rather than a Set: $state doesn't proxy Sets, and the category
	// count here is small enough that includes() is the cheaper thing to reason about.
	// Entries for categories that later disappear are inert, so nothing prunes them.
	let collapsed = $state<string[]>([]);

	function isCollapsed(category: string): boolean {
		return collapsed.includes(category);
	}

	function toggleGroup(category: string) {
		collapsed = isCollapsed(category) ? collapsed.filter((c) => c !== category) : [...collapsed, category];
	}

	function openIn(tasks: Task[]): number {
		return tasks.filter((task) => task.status !== 'done').length;
	}

	let openCount = $derived(openIn(visibleTasks));

	// Plain functions, not $derived: they're called from the template, so the `today`
	// read happens inside the render effect and still re-runs when onMount moves it to
	// the local date.
	function statusOf(task: Task): TaskDisplayStatus {
		return displayStatus(task, today);
	}

	function assigneeNames(task: Task): string {
		return task.assignees.map((a) => a.display_name).join(', ');
	}

	function toggleDetail(id: string) {
		if (openId === id && openMode === 'detail') {
			openId = null;
			return;
		}
		openId = id;
		openMode = 'detail';
	}

	// The whole row is clickable for convenience, but the name is a real button so the
	// panel is reachable from the keyboard too — that button stops propagation rather
	// than letting this handler toggle a second time on the same click.
	function handleRowClick(e: MouseEvent, id: string) {
		if ((e.target as HTMLElement).closest('button, a, input, select, label')) return;
		toggleDetail(id);
	}

	function startEdit(task: Task) {
		if (openId === task.id && openMode === 'edit') {
			openId = null;
			return;
		}
		openId = task.id;
		openMode = 'edit';
		editCategorySelect = task.category?.trim() || '';
		editCategoryNew = '';
		editAssignees = task.assignees.map((a) => a.user_id);
		rowError = null;
	}

	function cancelEdit() {
		openId = null;
		rowError = null;
	}

	async function handleSave(e: SubmitEvent, id: string) {
		e.preventDefault();
		const form = e.currentTarget as HTMLFormElement;

		rowError = null;
		savingId = id;

		const res = await fetch(form.action, { method: 'POST', body: new FormData(form) });

		if (!res.ok) {
			rowError = { id, message: await res.text() };
			savingId = null;
			return;
		}

		updateTask(await res.json());
		openId = null;
		savingId = null;
	}

	// The update endpoint writes the whole row — an absent field clears it, and an
	// absent `assignees` would drop every appointment — so flipping the status means
	// resubmitting the task exactly as it stands with only that one value changed.
	async function toggleDone(task: Task) {
		rowError = null;
		togglingId = task.id;

		const body = new FormData();
		body.set('name', task.name);
		body.set('category', task.category ?? '');
		body.set('description', task.description ?? '');
		body.set('deadline', task.deadline ?? '');
		body.set('status', task.status === 'done' ? 'ongoing' : 'done');
		for (const assignee of task.assignees) body.append('assignees', assignee.user_id);

		const res = await fetch(`/api/tasks/${task.id}/update`, { method: 'POST', body });

		if (!res.ok) {
			rowError = { id: task.id, message: await res.text() };
			togglingId = null;
			return;
		}

		updateTask(await res.json());
		togglingId = null;
	}

	async function handleDelete(id: string) {
		if (!confirm('Delete this task?')) return;

		rowError = null;
		deletingId = id;

		const res = await fetch(`/api/tasks/${id}/delete`, { method: 'POST' });

		if (!res.ok) {
			rowError = { id, message: await res.text() };
			deletingId = null;
			return;
		}

		removeTask(id);
		if (openId === id) openId = null;
		deletingId = null;
	}

	// addError is cleared here, not on close: the panel deliberately keeps a half-filled
	// row across a close, but a stale error from the last attempt shouldn't come back
	// with it.
	function openAddForm() {
		showAddForm = true;
		addError = null;
	}

	function closeAddForm() {
		showAddForm = false;
	}

	async function handleAddSubmit(e: SubmitEvent) {
		e.preventDefault();
		const form = e.currentTarget as HTMLFormElement;

		adding = true;
		addError = null;

		const res = await fetch(form.action, { method: 'POST', body: new FormData(form) });

		if (!res.ok) {
			addError = await res.text();
			adding = false;
			return;
		}

		addTask(await res.json());
		form.reset();
		addName = '';
		addCategorySelect = '';
		addCategoryNew = '';
		addDescription = '';
		addDeadline = '';
		addStatus = 'ongoing';
		addAssignees = [];
		showAddForm = false;
		adding = false;
	}
</script>

{#snippet categoryField(select: string, newValue: string, onSelect: (v: string) => void, onNew: (v: string) => void)}
	<label class="field">
		<span class="field-label">Category</span>
		<select value={select} onchange={(e) => onSelect((e.currentTarget as HTMLSelectElement).value)}>
			<option value="">None</option>
			{#each existingCategories as cat (cat)}
				<option value={cat}>{cat}</option>
			{/each}
			<option value={NEW_CATEGORY_VALUE}>+ Add category</option>
		</select>
		{#if select === NEW_CATEGORY_VALUE}
			<input
				type="text"
				placeholder="New category name"
				maxlength="100"
				value={newValue}
				oninput={(e) => onNew((e.currentTarget as HTMLInputElement).value)}
			/>
		{/if}
	</label>
{/snippet}

{#snippet assigneeField(selected: string[], onToggle: (id: string, on: boolean) => void)}
	<div class="field field-wide">
		<span class="field-label">Appointed members</span>
		{#if members.length === 0}
			<span class="field-value muted">No members to appoint.</span>
		{:else}
			<div class="assignee-picker">
				{#each members as member (member.id)}
					<label class="assignee-option">
						<input
							type="checkbox"
							name="assignees"
							value={member.id}
							checked={selected.includes(member.id)}
							onchange={(e) => onToggle(member.id, (e.currentTarget as HTMLInputElement).checked)}
						/>
						<span>{member.displayName}</span>
					</label>
				{/each}
			</div>
		{/if}
	</div>
{/snippet}

<section class="tasks-section">
	<div class="tasks-head">
		<h2>Tasks</h2>
		<!-- Counts follow the filter: a meta line reading the project total over a list
		     showing a subset of it would just look wrong. -->
		<span class="tasks-meta">
			{#if onlyMine}
				{visibleTasks.length} of {tasksState.tasks.length} task{tasksState.tasks.length === 1 ? '' : 's'}
			{:else}
				{visibleTasks.length} task{visibleTasks.length === 1 ? '' : 's'}
			{/if}
			· <strong>{openCount}</strong> open
		</span>

		<label class="mine-toggle">
			<input type="checkbox" bind:checked={onlyMine} />
			<span>Just my tasks</span>
		</label>

		{#if canEdit && !showAddForm}
			<button type="button" class="btn-plain add-toggle" onclick={openAddForm}>Add task</button>
		{/if}
	</div>

	{#if canEdit && showAddForm}
		<form
			method="POST"
			action={`/api/projects/${projectId}/tasks/create`}
			onsubmit={handleAddSubmit}
			class="task-panel add-panel"
			transition:slide={{ duration: 150 }}
		>
			<div class="panel-grid">
				<label class="field">
					<span class="field-label">Task name</span>
					<input type="text" name="name" placeholder="Task name" maxlength="200" required bind:value={addName} />
				</label>

				{@render categoryField(
					addCategorySelect,
					addCategoryNew,
					(v) => (addCategorySelect = v),
					(v) => (addCategoryNew = v),
				)}
				<input type="hidden" name="category" value={addCategoryEffective} />

				<label class="field">
					<span class="field-label">Deadline</span>
					<input type="date" name="deadline" bind:value={addDeadline} />
				</label>

				<label class="field">
					<span class="field-label">Status</span>
					<select name="status" bind:value={addStatus}>
						<option value="ongoing">Ongoing</option>
						<option value="done">Done</option>
					</select>
				</label>

				{@render assigneeField(addAssignees, (id, on) => {
					addAssignees = on ? [...addAssignees, id] : addAssignees.filter((a) => a !== id);
				})}

				<label class="field field-wide">
					<span class="field-label">Description</span>
					<input type="text" name="description" placeholder="Description" maxlength="1000" bind:value={addDescription} />
				</label>
			</div>

			{#if addError}<p class="panel-error">{addError}</p>{/if}

			<div class="panel-actions">
				<button type="submit" disabled={adding}>{adding ? 'Adding…' : 'Add task'}</button>
				<button type="button" class="btn-plain" onclick={closeAddForm}>Cancel</button>
			</div>
		</form>
	{/if}

	{#if tasksState.tasks.length === 0}
		<p class="muted empty">No tasks yet.</p>
	{:else if visibleTasks.length === 0}
		<p class="muted empty">No tasks are appointed to you.</p>
	{:else}
		<!-- A list, not a table: no outer frame, no vertical rules and no scroller of its
		     own, so it stays open and grows with the page. The columns are still a grid
		     with fixed fractions, so every row lines up even though nothing is drawn
		     around them. -->
		<div class="task-list" class:with-actions={canEdit}>
			<div class="list-head">
				<span>Task</span>
				<span>Description</span>
				<span>Appointed</span>
				<span>Deadline</span>
				<span>Status</span>
				{#if canEdit}<span></span>{/if}
			</div>

			{#each groups as group (group.category)}
				<!-- The band is a real button spanning the row, so a category folds from
				     the keyboard as well as the pointer. -->
				{#if showGroupHeaders}
					<button
						type="button"
						class="group-row"
						aria-expanded={!isCollapsed(group.category)}
						onclick={() => toggleGroup(group.category)}
					>
						<span class="group-caret" aria-hidden="true">{isCollapsed(group.category) ? '▸' : '▾'}</span>
						<span class="group-name">{group.category}</span>
						<span class="group-count">{openIn(group.tasks)} of {group.tasks.length} open</span>
					</button>
				{/if}

				{#if !isCollapsed(group.category)}
					{#each group.tasks as task (task.id)}
						{@const status = statusOf(task)}
						<div class="task-item" class:open={openId === task.id}>
							<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
							<div class="task-row" onclick={(e) => handleRowClick(e, task.id)}>
								<div class="cell cell-task">
									<button type="button" class="task-name" class:done={status === 'done'} onclick={(e) => {
										e.stopPropagation();
										toggleDetail(task.id);
									}}>{task.name}</button>
								</div>

								<!-- One line only, truncated: the full text is a click away in the
								     detail panel, and letting it wrap here would break the row grid's
								     baseline alignment. -->
								<div class="cell cell-description" title={task.description?.trim() || ''}>
									{task.description?.trim() || '—'}
								</div>

								<div class="cell cell-people">{assigneeNames(task) || '—'}</div>

								<div class="cell cell-deadline">
									{#if task.deadline}
										<span class="deadline-date">{task.deadline}</span>
										<span class="task-sub">{relativeDeadline(task.deadline, today)}</span>
									{:else}
										<span class="task-sub">no deadline</span>
									{/if}
								</div>

								<div class="cell cell-status">
									<span class="status status-{status}">{TASK_STATUS_LABELS[status]}</span>
								</div>

								{#if canEdit}
									<div class="cell cell-actions">
										<!-- Reopen rather than a second Done: the button has to say what
										     the click will do, and a task's status is editable from the
										     edit form either way. -->
										<button type="button" class="btn-plain" onclick={() => toggleDone(task)} disabled={togglingId === task.id}>
											{togglingId === task.id ? '…' : task.status === 'done' ? 'Reopen' : 'Done'}
										</button>
										<button type="button" class="btn-plain" onclick={() => startEdit(task)}>Edit</button>
										<button type="button" class="btn-danger" onclick={() => handleDelete(task.id)} disabled={deletingId === task.id}>
											{deletingId === task.id ? '…' : 'Delete'}
										</button>
									</div>
								{/if}
							</div>

							{#if openId === task.id && openMode === 'detail'}
								<div class="task-panel" transition:slide={{ duration: 150 }}>
									<dl class="detail">
										<dt>Category</dt>
										<dd>{task.category?.trim() || '—'}</dd>
										<dt>Appointed</dt>
										<dd>{assigneeNames(task) || '—'}</dd>
										<dt>Deadline</dt>
										<dd>
											{#if task.deadline}
												{task.deadline} <span class="muted">({relativeDeadline(task.deadline, today)})</span>
											{:else}
												—
											{/if}
										</dd>
										<dt>Description</dt>
										<dd>{task.description || '—'}</dd>
									</dl>
								</div>
							{/if}

							{#if canEdit && openId === task.id && openMode === 'edit'}
								<div class="task-panel" transition:slide={{ duration: 150 }}>
									<form method="POST" action={`/api/tasks/${task.id}/update`} onsubmit={(e) => handleSave(e, task.id)}>
										<div class="panel-grid">
											<label class="field">
												<span class="field-label">Task name</span>
												<input type="text" name="name" value={task.name} maxlength="200" required />
											</label>

											{@render categoryField(
												editCategorySelect,
												editCategoryNew,
												(v) => (editCategorySelect = v),
												(v) => (editCategoryNew = v),
											)}
											<input type="hidden" name="category" value={editCategoryEffective} />

											<label class="field">
												<span class="field-label">Deadline</span>
												<input type="date" name="deadline" value={task.deadline ?? ''} />
											</label>

											<!-- Only the two storable states. Overdue is derived from the
											     deadline, so it is never something to pick here. -->
											<label class="field">
												<span class="field-label">Status</span>
												<select name="status" value={task.status}>
													<option value="ongoing">Ongoing</option>
													<option value="done">Done</option>
												</select>
											</label>

											{@render assigneeField(editAssignees, (id, on) => {
												editAssignees = on ? [...editAssignees, id] : editAssignees.filter((a) => a !== id);
											})}

											<label class="field field-wide">
												<span class="field-label">Description</span>
												<input type="text" name="description" value={task.description ?? ''} maxlength="1000" />
											</label>
										</div>

										{#if rowError?.id === task.id}<p class="panel-error">{rowError.message}</p>{/if}

										<div class="panel-actions">
											<button type="submit" disabled={savingId === task.id}>{savingId === task.id ? 'Saving…' : 'Save'}</button>
											<button type="button" class="btn-plain" onclick={cancelEdit}>Cancel</button>
										</div>
									</form>
								</div>
							{/if}

							{#if rowError?.id === task.id && !(openId === task.id && openMode === 'edit')}
								<p class="row-error">{rowError.message}</p>
							{/if}
						</div>
					{/each}
				{/if}
			{/each}
		</div>
	{/if}
</section>

<style>
	/* Deliberately lighter than the Money page's sections: no rule above the heading,
	   since the summary strip already ends in one. */
	.tasks-section {
		margin-top: var(--space-5);
	}

	/* h2's default divider styling is zeroed here rather than by global.css's
	   .money-section-head rule — an Astro :global() selector can't reach through the
	   astro-island wrapper, so an island's first heading has to do this itself. */
	.tasks-head {
		display: flex;
		align-items: baseline;
		gap: var(--space-3);
		flex-wrap: wrap;
		margin-bottom: var(--space-3);
	}

	.tasks-head h2 {
		margin: 0;
		padding-top: 0;
		border-top: none;
	}

	.tasks-meta {
		font-size: 0.78rem;
		color: var(--color-muted);
		white-space: nowrap;
	}

	.tasks-meta strong {
		color: var(--color-fg);
		font-variant-numeric: tabular-nums;
	}

	/* The filter, not the Add button, carries the margin that pushes the right-hand
	   controls over — it's the one that renders for every role. */
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

	.add-toggle {
		padding: var(--space-1) var(--space-3);
		font-size: 0.8rem;
	}

	.empty {
		font-size: 0.85rem;
	}

	/* List */

	.task-list {
		--task-cols: minmax(0, 1.5fr) minmax(0, 1.6fr) minmax(0, 1fr) 118px 84px;
		border-top: 1px solid var(--color-border);
	}

	.task-list.with-actions {
		--task-cols: minmax(0, 1.5fr) minmax(0, 1.6fr) minmax(0, 1fr) 118px 84px 170px;
	}

	.list-head,
	.task-row {
		display: grid;
		grid-template-columns: var(--task-cols);
		gap: var(--space-3);
		align-items: baseline;
	}

	.list-head {
		padding: var(--space-2) var(--space-2);
		border-bottom: 1px solid var(--color-border);
		color: var(--color-muted);
		font-size: 0.64rem;
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	.task-item + .task-item {
		border-top: 1px solid var(--color-border);
	}

	/* Banded like the BOM's category rows, but a button — it folds its group. No rule
	   above it: the band's own background is separation enough, and a hard line there
	   read as a heavy black edge across the list. */
	.group-row {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		width: 100%;
		padding: var(--space-2);
		background: var(--color-highlight);
		border: none;
		color: var(--color-fg);
		font: inherit;
		font-size: 0.7rem;
		font-weight: 700;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		text-align: left;
		cursor: pointer;
	}

	.group-caret {
		flex-shrink: 0;
		font-size: 0.6rem;
		color: var(--color-muted);
	}

	.group-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.group-count {
		margin-left: auto;
		flex-shrink: 0;
		color: var(--color-muted);
		font-weight: 400;
		letter-spacing: 0.04em;
		font-variant-numeric: tabular-nums;
	}

	.task-row {
		padding: var(--space-3) var(--space-2);
		cursor: pointer;
		transition: background 0.12s ease;
	}

	.task-row:hover,
	.task-item.open .task-row {
		background: var(--color-highlight);
	}

	.cell {
		min-width: 0;
		font-size: 0.82rem;
	}

	.cell-task {
		display: flex;
		flex-direction: column;
		gap: 1px;
	}

	/* A real button so the panel opens from the keyboard, styled back down to plain
	   text — the row around it is only a convenience target. */
	.task-name {
		align-self: flex-start;
		max-width: 100%;
		background: none;
		border: none;
		padding: 0;
		margin: 0;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
		overflow-wrap: anywhere;
	}

	.task-name:hover {
		opacity: 1;
		text-decoration: underline;
		text-underline-offset: 3px;
	}

	.task-name.done {
		color: var(--color-muted);
		text-decoration: line-through;
	}

	.task-sub {
		color: var(--color-muted);
		font-size: 0.7rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.cell-description,
	.cell-people {
		color: var(--color-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.cell-deadline {
		display: flex;
		flex-direction: column;
		gap: 1px;
	}

	.deadline-date {
		font-variant-numeric: tabular-nums;
	}

	.status {
		font-size: 0.66rem;
		font-weight: 700;
		letter-spacing: 0.05em;
		text-transform: uppercase;
	}

	.status-overdue {
		color: var(--color-danger);
	}

	.status-done {
		color: var(--color-success);
	}

	.status-ongoing {
		color: var(--color-muted);
	}

	.cell-actions {
		display: flex;
		gap: var(--space-1);
		justify-content: flex-end;
	}

	.cell-actions button {
		flex-shrink: 0;
		white-space: nowrap;
		padding: 0 var(--space-2);
		font-size: 0.7rem;
		line-height: 1.8;
	}

	.row-error {
		margin: 0;
		padding: 0 var(--space-2) var(--space-3);
		color: var(--color-danger);
		font-size: 0.78rem;
	}

	/* Panels */

	.task-panel {
		padding: var(--space-1) var(--space-2) var(--space-4);
	}

	/* The add form is itself the panel, so it also has to undo the global flex-row
	   form styling that .task-panel form undoes for the nested edit forms. */
	.add-panel {
		display: block;
		padding: var(--space-3) var(--space-2) var(--space-4);
		border-top: 1px solid var(--color-border);
		border-bottom: 1px solid var(--color-border);
		margin: 0 0 var(--space-4);
	}

	/* Undo the global flex-row form styling — in a panel the form is just a block
	   wrapper around its grid and action row. */
	.task-panel form {
		display: block;
		margin: 0;
	}

	.detail {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		gap: var(--space-1) var(--space-4);
		margin: 0;
		max-width: 720px;
	}

	.detail dt {
		color: var(--color-muted);
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		line-height: 1.9;
	}

	.detail dd {
		margin: 0;
		font-size: 0.82rem;
		overflow-wrap: break-word;
		word-break: break-word;
	}

	.panel-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: var(--space-3);
		align-items: start;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		min-width: 0;
	}

	.field-label {
		color: var(--color-muted);
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.05em;
		text-transform: uppercase;
	}

	.field input,
	.field select {
		width: 100%;
		min-width: 0;
		padding: var(--space-1) var(--space-2);
		font-size: 0.82rem;
	}

	.field .field-value {
		font-size: 0.82rem;
	}

	.field-wide {
		grid-column: 1 / -1;
	}

	.assignee-picker {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1) var(--space-3);
	}

	.assignee-option {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		font-size: 0.8rem;
		min-width: 0;
	}

	/* Out-ranks `.field input { width: 100% }` above, which would otherwise stretch each
	   checkbox across its row. Svelte scopes with :where(), so the selector has to win
	   on its own specificity. */
	.field .assignee-option input {
		width: auto;
		min-width: 0;
		padding: 0;
		margin: 0;
	}

	.panel-actions {
		display: flex;
		gap: var(--space-2);
		align-items: center;
		margin-top: var(--space-3);
	}

	.panel-actions button {
		padding: var(--space-1) var(--space-3);
		font-size: 0.8rem;
	}

	.panel-error {
		color: var(--color-danger);
		font-size: 0.78rem;
		margin: var(--space-2) 0 0;
	}

	/* Below this the columns stop fitting, so each row becomes a small block: the name
	   heads it, then description, appointment and deadline stacked under it, controls
	   last. */
	@media (max-width: 900px) {
		.list-head {
			display: none;
		}

		.task-list,
		.task-list.with-actions {
			--task-cols: minmax(0, 1fr) auto;
		}

		.task-row {
			row-gap: var(--space-1);
			align-items: start;
		}

		.cell-description,
		.cell-people,
		.cell-deadline {
			grid-column: 1 / -1;
			font-size: 0.76rem;
		}

		.cell-deadline {
			flex-direction: row;
			gap: var(--space-2);
		}

		.cell-actions {
			grid-column: 1 / -1;
			justify-content: flex-start;
			margin-top: var(--space-1);
		}
	}
</style>
