<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { slide } from 'svelte/transition';
	import TasksCalendar from './TasksCalendar.svelte';
	import { tasksState, initTasks, addTask, updateTask, removeTask, type Task } from '../lib/tasks-store.svelte';
	import {
		CATEGORY_COLOR_SLOTS,
		categoryColorIndex,
		categoryColorStyle,
		categoryStyle,
		type CategoryColors,
	} from '../lib/category-color';
	import {
		displayStatus,
		formatDeadline,
		localToday,
		relativeDeadline,
		TASK_STATUS_LABELS,
		type TaskDisplayStatus,
	} from '../lib/task-status';

	let {
		projectId,
		initialTasks,
		initialCategoryColors,
		initialViewMode,
		members,
		canEdit,
		currentUserId,
		serverToday,
	}: {
		projectId: string;
		initialTasks: Task[];
		initialCategoryColors: CategoryColors;
		initialViewMode: 'list' | 'calendar';
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

		openLinkedTask();
		// A second reminder for a task on a page that's already open only changes the
		// hash, which is not a navigation — without this the link would do nothing.
		window.addEventListener('hashchange', openLinkedTask);
		return () => window.removeEventListener('hashchange', openLinkedTask);
	});

	// `#task-<id>`, the form the Reminders list on the Dashboard and on a project's
	// Overview links with. Opening the panel is the point of the link, so this also
	// clears anything that would keep the task from being on screen to open: a filter
	// that hides it, or a collapsed category it sits inside.
	async function openLinkedTask() {
		const hash = location.hash;
		if (!hash.startsWith('#task-')) return;

		const id = hash.slice('#task-'.length);
		const task = tasksState.tasks.find((t) => t.id === id);
		if (!task) return;

		if (onlyMine && !task.assignees.some((a) => a.user_id === currentUserId)) onlyMine = false;
		collapsed = collapsed.filter((c) => c !== (task.category?.trim() || UNCATEGORIZED));

		openId = id;
		openMode = 'detail';

		// The row may only exist after those two land, so the scroll waits for the render
		// rather than looking for an element that isn't there yet. In Calendar mode the
		// panel is under the grid instead, which carries the same id.
		await tick();
		document.getElementById(`task-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
	}

	// List or Calendar, in the Grid/List picker's styling. The initial value comes down
	// as a prop read from a cookie rather than from localStorage at init, for the same
	// reason FileBrowser's does: reading storage on the client only would render the
	// list during SSR and swap to the calendar on hydrate, which is a visible flash.
	let viewMode = $state<'list' | 'calendar'>(initialViewMode);

	function setViewMode(mode: 'list' | 'calendar') {
		viewMode = mode;
		localStorage.setItem('p2-task-view-mode', mode);
		document.cookie = `p2-task-view-mode=${mode}; path=/; max-age=31536000; samesite=lax`;
	}

	// Only the categories somebody has picked a colour for; everything else falls back
	// to a hash of the name inside categoryStyle. Not a shared store — the summary
	// island doesn't render categories, so this component and its calendar child are
	// the whole audience.
	let categoryColors = $state<CategoryColors>({ ...initialCategoryColors });

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

	let savingColor = $state<string | null>(null);
	let colorError = $state<string | null>(null);

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

	// The calendar has no rows to hang a panel off, so the open task is looked up here
	// and its panel rendered under the grid.
	let selectedTask = $derived(visibleTasks.find((task) => task.id === openId) ?? null);

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
	// the local date. The colour ones read `categoryColors` the same way, so a swatch
	// click repaints every band and popsicle in that category at once.
	function statusOf(task: Task): TaskDisplayStatus {
		return displayStatus(task, today);
	}

	function styleFor(category: string | null): string {
		return categoryStyle(category, categoryColors);
	}

	// The calendar's uncategorized tasks have to fall back to the neutral chip, and the
	// list's 'Uncategorized' band likewise — both get '' from categoryStyle, which is
	// what leaves the var() fallbacks in the CSS to do it.
	function styleForTask(task: Task): string {
		return styleFor(task.category);
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
		colorError = null;
	}

	function cancelEdit() {
		openId = null;
		rowError = null;
	}

	// A category's colour belongs to the project, not to the task being edited, so it
	// saves on the click rather than waiting for the form — Cancel shouldn't undo a
	// colour, and a colour change shouldn't need a task edit to carry it. The swatches
	// stay disabled until the category has a name, which is also what keeps a
	// half-typed '+ Add category' from writing a row under a partial name.
	async function setCategoryColor(category: string, index: number) {
		const name = category.trim();
		if (!name || savingColor) return;

		colorError = null;
		savingColor = name;

		const body = new FormData();
		body.set('name', name);
		body.set('color_index', String(index));

		const res = await fetch(`/api/projects/${projectId}/task-categories/color`, { method: 'POST', body });

		if (!res.ok) {
			colorError = await res.text();
			savingColor = null;
			return;
		}

		const saved = await res.json() as { name: string; color_index: number };
		categoryColors = { ...categoryColors, [saved.name]: saved.color_index };
		savingColor = null;
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
		colorError = null;
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

<!-- A div rather than a label, unlike the other fields: the colour swatches are real
     buttons, and a button inside a label activates the label's control on click. -->
{#snippet categoryField(
	select: string,
	newValue: string,
	effective: string,
	onSelect: (v: string) => void,
	onNew: (v: string) => void,
)}
	<div class="field">
		<span class="field-label">Category</span>
		<select
			aria-label="Category"
			value={select}
			onchange={(e) => onSelect((e.currentTarget as HTMLSelectElement).value)}
		>
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

		<!-- Ten fixed slots. The active one is whichever the category resolves to right
		     now, picked or hashed, so the row always shows the colour the list and the
		     calendar are actually painting rather than 'nothing chosen'. -->
		<div class="swatches" role="group" aria-label="Category colour">
			{#each CATEGORY_COLOR_SLOTS as slot (slot)}
				<button
					type="button"
					class="swatch"
					class:active={effective.trim() !== '' && categoryColorIndex(effective, categoryColors) === slot}
					style={categoryColorStyle(slot)}
					disabled={effective.trim() === '' || savingColor !== null}
					aria-label={`Colour ${slot + 1}`}
					title={effective.trim() === '' ? 'Pick a category first' : `Colour ${slot + 1}`}
					onclick={() => setCategoryColor(effective, slot)}
				></button>
			{/each}
		</div>
		{#if colorError}<span class="swatch-error">{colorError}</span>{/if}
	</div>
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

<!-- The three below are shared by the list rows and the calendar's selected-task
     panel: the calendar has no row of its own to hang them off, and two copies of an
     edit form is exactly how the two views would drift apart. -->
{#snippet taskActions(task: Task)}
	<div class="cell-actions">
		<!-- Reopen rather than a second Done: the button has to say what the click will
		     do, and a task's status is editable from the edit form either way. -->
		<button type="button" class="btn-plain" onclick={() => toggleDone(task)} disabled={togglingId === task.id}>
			{togglingId === task.id ? '…' : task.status === 'done' ? 'Reopen' : 'Done'}
		</button>
		<button type="button" class="btn-plain" onclick={() => startEdit(task)}>Edit</button>
		<button type="button" class="btn-danger" onclick={() => handleDelete(task.id)} disabled={deletingId === task.id}>
			{deletingId === task.id ? '…' : 'Delete'}
		</button>
	</div>
{/snippet}

{#snippet detailBody(task: Task)}
	<dl class="detail">
		<dt>Category</dt>
		<dd>
			{#if task.category?.trim()}
				<span class="category-chip" style={styleFor(task.category)}>{task.category.trim()}</span>
			{:else}
				—
			{/if}
		</dd>
		<dt>Appointed</dt>
		<dd>{assigneeNames(task) || '—'}</dd>
		<dt>Deadline</dt>
		<dd>
			{#if task.deadline}
				{formatDeadline(task.deadline, today)} <span class="muted">({relativeDeadline(task.deadline, today)})</span>
			{:else}
				—
			{/if}
		</dd>
		<dt>Description</dt>
		<dd>{task.description || '—'}</dd>
	</dl>
{/snippet}

{#snippet editForm(task: Task)}
	<form method="POST" action={`/api/tasks/${task.id}/update`} onsubmit={(e) => handleSave(e, task.id)}>
		<div class="panel-grid">
			<label class="field">
				<span class="field-label">Task name</span>
				<input type="text" name="name" value={task.name} maxlength="200" required />
			</label>

			{@render categoryField(
				editCategorySelect,
				editCategoryNew,
				editCategoryEffective,
				(v) => (editCategorySelect = v),
				(v) => (editCategoryNew = v),
			)}
			<input type="hidden" name="category" value={editCategoryEffective} />

			<label class="field">
				<span class="field-label">Deadline</span>
				<input type="date" name="deadline" value={task.deadline ?? ''} />
			</label>

			<!-- Only the two storable states. Overdue is derived from the deadline, so it
			     is never something to pick here. -->
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

		<!-- Same square icon boxes and inverted active state as the Files page's
		     Grid/List picker. -->
		<div class="view-toggle">
			<button
				type="button"
				class="btn-plain"
				class:active={viewMode === 'list'}
				aria-pressed={viewMode === 'list'}
				aria-label="List view"
				title="List view"
				onclick={() => setViewMode('list')}
			>
				<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
					<rect x="1" y="2" width="2" height="2" rx="0.5" />
					<rect x="5" y="2" width="10" height="2" rx="1" />
					<rect x="1" y="7" width="2" height="2" rx="0.5" />
					<rect x="5" y="7" width="10" height="2" rx="1" />
					<rect x="1" y="12" width="2" height="2" rx="0.5" />
					<rect x="5" y="12" width="10" height="2" rx="1" />
				</svg>
			</button>
			<button
				type="button"
				class="btn-plain"
				class:active={viewMode === 'calendar'}
				aria-pressed={viewMode === 'calendar'}
				aria-label="Calendar view"
				title="Calendar view"
				onclick={() => setViewMode('calendar')}
			>
				<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
					<rect x="1" y="1" width="14" height="3" rx="1" />
					<rect x="1" y="6" width="3" height="3" rx="0.5" />
					<rect x="6.5" y="6" width="3" height="3" rx="0.5" />
					<rect x="12" y="6" width="3" height="3" rx="0.5" />
					<rect x="1" y="11" width="3" height="3" rx="0.5" />
					<rect x="6.5" y="11" width="3" height="3" rx="0.5" />
					<rect x="12" y="11" width="3" height="3" rx="0.5" />
				</svg>
			</button>
		</div>

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
					addCategoryEffective,
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

	{#if viewMode === 'calendar'}
		<TasksCalendar tasks={visibleTasks} today={today} colorFor={styleForTask} onSelect={toggleDetail} selectedId={openId} />

		<!-- The grid has no rows, so the open task's panel lands under it — with the
		     row controls it would otherwise have nowhere to live. -->
		{#if selectedTask}
			{#if openMode === 'edit' && canEdit}
				<div class="task-panel calendar-panel" transition:slide={{ duration: 150 }}>
					{@render editForm(selectedTask)}
				</div>
			{:else}
				<!-- Carries the `#task-<id>` anchor in this mode: the grid has no row to put
				     it on, and a linked task's deadline may not even be in the month on
				     screen, but its panel always renders here. -->
				<div class="task-panel calendar-panel" id={`task-${selectedTask.id}`} transition:slide={{ duration: 150 }}>
					<div class="panel-head">
						<strong class="panel-title" class:done={statusOf(selectedTask) === 'done'}>{selectedTask.name}</strong>
						<span class="status status-{statusOf(selectedTask)}">{TASK_STATUS_LABELS[statusOf(selectedTask)]}</span>
						{#if canEdit}{@render taskActions(selectedTask)}{/if}
					</div>
					{@render detailBody(selectedTask)}
					{#if rowError?.id === selectedTask.id}<p class="panel-error">{rowError.message}</p>{/if}
				</div>
			{/if}
		{/if}
	{:else if tasksState.tasks.length === 0}
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
				     the keyboard as well as the pointer. It's also where the category's
				     colour shows in List mode — the same colour its popsicles take in
				     Calendar mode. -->
				{#if showGroupHeaders}
					<button
						type="button"
						class="group-row"
						style={group.category === UNCATEGORIZED ? '' : styleFor(group.category)}
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
						<!-- The anchor a `#task-<id>` link scrolls to — see openLinkedTask. -->
						<div class="task-item" id={`task-${task.id}`} class:open={openId === task.id}>
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
										<span class="deadline-date">{formatDeadline(task.deadline, today)}</span>
										<span class="task-sub">{relativeDeadline(task.deadline, today)}</span>
									{:else}
										<span class="task-sub">no deadline</span>
									{/if}
								</div>

								<div class="cell cell-status">
									<span class="status status-{status}">{TASK_STATUS_LABELS[status]}</span>
								</div>

								{#if canEdit}
									<div class="cell cell-actions-wrap">{@render taskActions(task)}</div>
								{/if}
							</div>

							{#if openId === task.id && openMode === 'detail'}
								<div class="task-panel" transition:slide={{ duration: 150 }}>
									{@render detailBody(task)}
								</div>
							{/if}

							{#if canEdit && openId === task.id && openMode === 'edit'}
								<div class="task-panel" transition:slide={{ duration: 150 }}>
									{@render editForm(task)}
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
	   controls over — it's the first one that renders for every role. */
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

	/* align-self, because the head is baseline-aligned and these boxes hold nothing
	   with a baseline to align on. */
	.view-toggle {
		display: flex;
		gap: var(--space-2);
		flex: 0 0 auto;
		align-self: center;
	}

	.view-toggle button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-1);
		line-height: 0;
	}

	.view-toggle svg {
		width: 14px;
		height: 14px;
		fill: currentColor;
	}

	.view-toggle button.active {
		background: var(--color-fg);
		color: var(--color-bg);
	}

	.add-toggle {
		padding: var(--space-1) var(--space-3);
		font-size: 0.8rem;
	}

	.empty {
		font-size: 0.85rem;
	}

	/* List */

	/* The deadline track fits 'September 27' at the cell's font size, with the year only
	   ever added for a deadline outside this one — where a little truncation is the
	   right trade for keeping every other row tight. */
	.task-list {
		--task-cols: minmax(0, 1.5fr) minmax(0, 1.6fr) minmax(0, 1fr) 124px 84px;
		border-top: 1px solid var(--color-border);
	}

	.task-list.with-actions {
		--task-cols: minmax(0, 1.5fr) minmax(0, 1.6fr) minmax(0, 1fr) 124px 84px 170px;
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
	   read as a heavy black edge across the list. The fill is the category's own colour
	   where it has one; 'Uncategorized' is passed no style at all and falls back to the
	   neutral highlight, so a colour never implies a category that isn't there. */
	.group-row {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		width: 100%;
		padding: var(--space-2);
		background: var(--cat-bg, var(--color-highlight));
		border: none;
		color: var(--cat-fg, var(--color-fg));
		font: inherit;
		font-size: 0.7rem;
		font-weight: 700;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		text-align: left;
		cursor: pointer;
	}

	/* Inherit rather than --color-muted: a fixed grey doesn't stay readable across ten
	   fills, and the fill's own foreground already does. */
	.group-caret {
		flex-shrink: 0;
		font-size: 0.6rem;
		color: inherit;
		opacity: 0.7;
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
		color: inherit;
		opacity: 0.7;
		font-weight: 400;
		letter-spacing: 0.04em;
		font-variant-numeric: tabular-nums;
	}

	/* Tight rows: the list is meant to be scanned, and body copy's 1.6 line-height over
	   a two-line deadline cell was spending most of a row's height on air. The padding
	   still has to clear the row controls, which set their own line-height. */
	.task-row {
		padding: var(--space-2);
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
		line-height: 1.35;
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
		line-height: 1.3;
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

	/* One line whatever the month is called: a wrap here would put back the height the
	   row just gave up. */
	.deadline-date {
		font-variant-numeric: tabular-nums;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
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

	/* The calendar's panel is a block on open space rather than a slot between rows, so
	   it carries the rule the row above it would have drawn. */
	.calendar-panel {
		padding-top: var(--space-3);
	}

	.panel-head {
		display: flex;
		align-items: baseline;
		gap: var(--space-3);
		flex-wrap: wrap;
		margin-bottom: var(--space-3);
	}

	.panel-title {
		font-size: 0.9rem;
		overflow-wrap: anywhere;
	}

	.panel-title.done {
		color: var(--color-muted);
		text-decoration: line-through;
	}

	.panel-head .cell-actions {
		margin-left: auto;
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

	/* The detail panel is the one place the category is named in full, so it carries
	   the colour there too — the same fill as the band and the popsicle. */
	.category-chip {
		display: inline-block;
		padding: 0 var(--space-2);
		background: var(--cat-bg, var(--color-border));
		color: var(--cat-fg, var(--color-fg));
		font-size: 0.75rem;
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

	/* Ten swatches on one row under the category select. They wrap rather than shrink,
	   so the field can narrow to the panel grid's 180px track without them turning into
	   slivers. */
	.swatches {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1);
		margin-top: 2px;
	}

	.swatch {
		width: 18px;
		height: 18px;
		flex: 0 0 auto;
		padding: 0;
		border: 1px solid var(--color-border);
		background: var(--cat-bg);
		cursor: pointer;
	}

	.swatch.active {
		border-color: var(--color-border-strong);
		outline: 1px solid var(--color-border-strong);
		outline-offset: -3px;
	}

	.swatch:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.swatch-error {
		color: var(--color-danger);
		font-size: 0.7rem;
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

		.cell-actions-wrap {
			grid-column: 1 / -1;
			margin-top: var(--space-1);
		}

		.cell-actions-wrap .cell-actions {
			justify-content: flex-start;
		}
	}
</style>
