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
		serverToday,
	}: {
		projectId: string;
		initialTasks: Task[];
		members: { id: string; displayName: string }[];
		canEdit: boolean;
		serverToday: string;
	} = $props();

	initTasks(initialTasks);

	// Server's date first so SSR and hydration render the same statuses, then the
	// reader's own calendar day once mounted — see task-status.ts.
	let today = $state(serverToday);

	onMount(() => {
		today = localToday();
	});

	// One row panel is open at a time: either its read-only detail or its edit form,
	// exactly as the Money tables do it.
	let openId = $state<string | null>(null);
	let openMode = $state<'detail' | 'edit'>('detail');

	let savingId = $state<string | null>(null);
	let deletingId = $state<string | null>(null);
	let rowError = $state<{ id: string; message: string } | null>(null);

	let adding = $state(false);
	let addError = $state<string | null>(null);
	let showAddForm = $state(false);
	let addButtonVisible = $state(true);
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

	let colCount = $derived(canEdit ? 6 : 5);

	// Same derivation as BomTable's: the dropdown offers whatever categories the
	// current tasks already use, so the backend still only ever stores free text.
	let existingCategories = $derived(
		[...new Set(tasksState.tasks.map((task) => task.category?.trim()).filter((c): c is string => !!c))].sort((a, b) =>
			a.localeCompare(b),
		),
	);

	let addCategoryEffective = $derived(addCategorySelect === NEW_CATEGORY_VALUE ? addCategoryNew : addCategorySelect);
	let editCategoryEffective = $derived(editCategorySelect === NEW_CATEGORY_VALUE ? editCategoryNew : editCategorySelect);

	let openCount = $derived(tasksState.tasks.filter((task) => task.status !== 'done').length);

	// Plain functions, not $derived: they're called from the template, so the `today`
	// read happens inside the render effect and still re-runs when onMount moves it to
	// the local date.
	function statusOf(task: Task): TaskDisplayStatus {
		return displayStatus(task, today);
	}

	function assigneeNames(task: Task): string {
		return task.assignees.map((a) => a.display_name).join(', ');
	}

	function handleRowClick(e: MouseEvent, id: string) {
		if ((e.target as HTMLElement).closest('.row-actions, a')) return;
		if (openId === id && openMode === 'detail') {
			openId = null;
			return;
		}
		openId = id;
		openMode = 'detail';
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
		addButtonVisible = false;
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

<section class="money-section">
	<div class="money-section-head">
		<h2>Tasks</h2>
		<span class="section-meta">
			{tasksState.tasks.length} task{tasksState.tasks.length === 1 ? '' : 's'} · <strong>{openCount}</strong> open
		</span>
	</div>

	{#if tasksState.tasks.length === 0}
		<p class="muted empty">No tasks yet.</p>
	{:else}
		<!-- Capped height rather than a table that grows the page without bound: the
		     list scrolls inside itself and the header band stays pinned to the top of
		     the scroller. -->
		<div class="money-table tasks-scroll">
			<table>
				<colgroup>
					<col style="width:220px" />
					<col style="width:130px" />
					<col style="width:180px" />
					<col style="width:110px" />
					<col style="width:90px" />
					{#if canEdit}<col style="width:130px" />{/if}
				</colgroup>
				<thead>
					<tr>
						<th>Task</th>
						<th>Category</th>
						<th>Appointed</th>
						<th>Deadline</th>
						<th>Status</th>
						{#if canEdit}<th><span class="sr-only">Actions</span></th>{/if}
					</tr>
				</thead>
				<tbody>
					{#each tasksState.tasks as task (task.id)}
						<tr class="data-row clickable" class:open={openId === task.id} onclick={(e) => handleRowClick(e, task.id)}>
							<td>{task.name}</td>
							<td>{task.category?.trim() || ''}</td>
							<td>{assigneeNames(task) || ''}</td>
							<td>{task.deadline ?? ''}</td>
							<td>
								<span class="status-badge status-{statusOf(task)}">{TASK_STATUS_LABELS[statusOf(task)]}</span>
							</td>
							{#if canEdit}
								<td class="actions-cell">
									<div class="row-actions">
										<button type="button" class="btn-plain" onclick={() => startEdit(task)}>Edit</button>
										<button type="button" class="btn-danger" onclick={() => handleDelete(task.id)} disabled={deletingId === task.id}>
											{deletingId === task.id ? '…' : 'Delete'}
										</button>
									</div>
								</td>
							{/if}
						</tr>

						{#if openId === task.id && openMode === 'detail'}
							<tr class="panel-row">
								<td colspan={colCount}>
									<div class="money-panel" transition:slide={{ duration: 150 }}>
										<div class="panel-grid">
											<div class="field">
												<span class="field-label">Task</span>
												<span class="field-value">{task.name}</span>
											</div>
											<div class="field">
												<span class="field-label">Category</span>
												<span class="field-value">{task.category?.trim() || '—'}</span>
											</div>
											<div class="field">
												<span class="field-label">Status</span>
												<span class="field-value">{TASK_STATUS_LABELS[statusOf(task)]}</span>
											</div>
											<div class="field">
												<span class="field-label">Deadline</span>
												<span class="field-value">
													{#if task.deadline}
														{task.deadline} <span class="muted">({relativeDeadline(task.deadline, today)})</span>
													{:else}
														—
													{/if}
												</span>
											</div>
											<div class="field field-wide">
												<span class="field-label">Appointed members</span>
												<span class="field-value">{assigneeNames(task) || '—'}</span>
											</div>
											<div class="field field-wide">
												<span class="field-label">Description</span>
												<span class="field-value">{task.description || '—'}</span>
											</div>
										</div>
									</div>
								</td>
							</tr>
						{/if}

						{#if canEdit && openId === task.id && openMode === 'edit'}
							<tr class="panel-row">
								<td colspan={colCount}>
									<div class="money-panel" transition:slide={{ duration: 150 }}>
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

												<div class="field field-wide">
													<span class="field-label">Appointed members</span>
													{#if members.length === 0}
														<span class="field-value muted">No members to appoint.</span>
													{:else}
														<div class="assignee-picker">
															{#each members as member (member.id)}
																<label class="assignee-option">
																	<input type="checkbox" name="assignees" value={member.id} bind:group={editAssignees} />
																	<span>{member.displayName}</span>
																</label>
															{/each}
														</div>
													{/if}
												</div>

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
								</td>
							</tr>
						{/if}

						{#if rowError?.id === task.id && !(openId === task.id && openMode === 'edit')}
							<tr class="row-error">
								<td colspan={colCount}>{rowError.message}</td>
							</tr>
						{/if}
					{/each}
				</tbody>
			</table>
		</div>
	{/if}

	{#if canEdit}
		<form method="POST" action={`/api/projects/${projectId}/tasks/create`} onsubmit={handleAddSubmit} class="add-form">
			{#if showAddForm}
				<div class="money-panel add-panel" transition:slide={{ duration: 150 }} onoutroend={() => (addButtonVisible = true)}>
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

						<div class="field field-wide">
							<span class="field-label">Appointed members</span>
							{#if members.length === 0}
								<span class="field-value muted">No members to appoint.</span>
							{:else}
								<div class="assignee-picker">
									{#each members as member (member.id)}
										<label class="assignee-option">
											<input type="checkbox" name="assignees" value={member.id} bind:group={addAssignees} />
											<span>{member.displayName}</span>
										</label>
									{/each}
								</div>
							{/if}
						</div>

						<label class="field field-wide">
							<span class="field-label">Description</span>
							<input type="text" name="description" placeholder="Description" maxlength="1000" bind:value={addDescription} />
						</label>
					</div>

					{#if addError}<p class="panel-error">{addError}</p>{/if}
				</div>
			{/if}

			<div class="add-form-actions">
				{#if addButtonVisible}
					<button type="button" class="btn-plain" onclick={openAddForm}>Add task</button>
				{:else}
					<button type="submit" disabled={adding}>{adding ? 'Adding…' : 'Add task'}</button>
					<button type="button" class="btn-plain" onclick={closeAddForm}>Cancel</button>
				{/if}
			</div>
		</form>
	{/if}
</section>

<style>
	/* The list scrolls inside itself instead of growing the page: 60vh keeps the
	   table shorter than the viewport however many tasks a project accumulates, so
	   the Add form below it stays reachable without scrolling past the whole list. */
	.tasks-scroll {
		max-height: 60vh;
		overflow-y: auto;
	}

	/* border-collapse: collapse (global.css) drops a sticky cell's own borders once
	   it detaches from the flow, so the header band's bottom rule is drawn as an
	   inset shadow instead — it rides along with the element either way. */
	.tasks-scroll thead th {
		position: sticky;
		top: 0;
		z-index: 1;
		box-shadow: inset 0 -1px 0 var(--color-border-strong);
	}

	.status-badge {
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.04em;
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

	/* Three classes deep on purpose: global.css's `.money-panel .field input` sets
	   width: 100% for text fields, which would stretch each checkbox across its row.
	   Svelte scopes with :where(), so it adds no specificity of its own and the
	   selector has to out-rank that rule on its own merits. */
	.money-panel .field .assignee-option input {
		width: auto;
		min-width: 0;
		padding: 0;
		margin: 0;
	}

	.empty {
		font-size: 0.85rem;
	}

	.add-form {
		display: block;
		margin: 0;
	}

	.add-panel {
		border: 1px solid var(--color-border-strong);
		margin-bottom: var(--space-2);
	}

	.add-form-actions {
		display: flex;
		gap: var(--space-2);
		align-items: center;
	}

	.add-form-actions button {
		padding: var(--space-1) var(--space-3);
		font-size: 0.8rem;
	}

	/* top/left pinned rather than left at their static position — see BomTable for
	   the horizontal-overflow bug an unpinned one caused on mobile. */
	.sr-only {
		position: absolute;
		top: 0;
		left: 0;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}
</style>
