<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { slide } from 'svelte/transition';
	import TasksCalendar from './TasksCalendar.svelte';
	import Avatar from './Avatar.svelte';
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
		relativeDeadline,
		TASK_STATUS_LABELS,
		type TaskDisplayStatus,
	} from '../lib/task-status';
	import { DEFAULT_DEADLINE_TIME, formatDeadlineTime } from '../lib/deadline-time';
	import { DELETED_ASSIGNEE_PREFIX } from '../lib/task-form';
	import { ghostPartyId } from '../lib/money-parties';
	import { downloadJson, exportFilename } from '../lib/download';

	function assigneeToken(assignee: Task['assignees'][number]): string {
		if (assignee.user_id) return assignee.user_id;
		if (assignee.ghost_member_id) return ghostPartyId(assignee.ghost_member_id);
		return `${DELETED_ASSIGNEE_PREFIX}${assignee.id}`;
	}

	let {
		projectId,
		projectName,
		initialTasks,
		initialCategoryColors,
		initialViewMode,
		members,
		ghostMembers,
		canEdit,
		currentUserId,
		serverToday,
		serverNowTime,
	}: {
		projectId: string;
		projectName: string;
		initialTasks: Task[];
		initialCategoryColors: CategoryColors;
		initialViewMode: 'list' | 'calendar';
		members: { id: string; displayName: string; avatar: string | null }[];
		ghostMembers: { id: string; displayName: string }[];
		canEdit: boolean;
		currentUserId: string;
		serverToday: string;
		serverNowTime: string;
	} = $props();

	initTasks(initialTasks);

	// Rendered on the server and reused as-is: it's an Asia/Manila date either way,
	// so there's nothing for the client to correct — see today.ts.
	const today = serverToday;
	// The clock half of the same moment, for the deadline that falls on `today` — see
	// today.ts and task-status.ts.
	const nowTime = serverNowTime;

	onMount(() => {
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
		editingField = null;

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

	// One task's panel is open at a time. There is no separate edit mode anymore: the
	// panel is the edit surface, one field at a time (see editingField below).
	let openId = $state<string | null>(null);

	// Which single field of which task is currently being edited in the open panel.
	// One at a time on purpose — each field saves the whole row through the update
	// endpoint, so two open fields would race each other's values.
	type EditField = 'name' | 'category' | 'appointed' | 'deadline' | 'description';
	let editingField = $state<{ id: string; field: EditField } | null>(null);

	// Drafts for the field being edited. Plain state rather than form inputs read on
	// submit: the check/cancel icons aren't a form, and a draft has to survive the
	// swatch clicks that sit next to the category select.
	let draftName = $state('');
	let draftDeadline = $state('');
	let draftDeadlineTime = $state(DEFAULT_DEADLINE_TIME);
	let draftDescription = $state('');

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
	// Pre-filled rather than left empty: a deadline with no stated time is due at the end
	// of its day, and showing that up front beats storing it silently — see
	// deadline-time.ts.
	let addDeadlineTime = $state(DEFAULT_DEADLINE_TIME);
	let addStatus = $state<'ongoing' | 'done'>('ongoing');
	let addAssignees = $state<string[]>([]);

	let editCategorySelect = $state('');
	let editCategoryNew = $state('');

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
		return displayStatus(task, today, nowTime);
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

	function toggleDetail(id: string) {
		editingField = null;
		rowError = null;
		if (openId === id) {
			openId = null;
			return;
		}
		openId = id;
	}

	// The whole row is clickable for convenience, but the name is a real button so the
	// panel is reachable from the keyboard too — that button stops propagation rather
	// than letting this handler toggle a second time on the same click.
	function handleRowClick(e: MouseEvent, id: string) {
		if ((e.target as HTMLElement).closest('button, a, input, select, label')) return;
		toggleDetail(id);
	}

	function isEditing(id: string, field: EditField): boolean {
		return editingField?.id === id && editingField.field === field;
	}

	// The pencil beside a value toggles: a second click on the same one closes it, and
	// clicking another field's pencil moves the edit rather than opening a second.
	function startField(task: Task, field: EditField) {
		if (isEditing(task.id, field)) {
			editingField = null;
			return;
		}

		rowError = null;
		colorError = null;
		editingField = { id: task.id, field };

		if (field === 'name') draftName = task.name;
		if (field === 'category') {
			editCategorySelect = task.category?.trim() || '';
			editCategoryNew = '';
		}
		if (field === 'deadline') {
			draftDeadline = task.deadline ?? '';
			draftDeadlineTime = task.deadline_time;
		}
		if (field === 'description') draftDescription = task.description ?? '';
	}

	function cancelField() {
		editingField = null;
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

	// The update endpoint writes the whole row — an absent field clears it, and an
	// absent `assignees` would drop every appointment — so every edit resubmits the
	// task exactly as it stands with only the changed values swapped in. That's what
	// lets a single field (or the Done button) save on its own.
	async function saveField(
		task: Task,
		changes: Partial<{
			name: string;
			category: string;
			description: string;
			deadline: string;
			deadline_time: string;
			status: 'ongoing' | 'done';
			assignees: string[];
		}>,
	): Promise<boolean> {
		rowError = null;
		savingId = task.id;

		const body = new FormData();
		body.set('name', changes.name ?? task.name);
		body.set('category', changes.category ?? task.category ?? '');
		body.set('description', changes.description ?? task.description ?? '');
		body.set('deadline', changes.deadline ?? task.deadline ?? '');
		body.set('deadline_time', changes.deadline_time ?? task.deadline_time);
		body.set('status', changes.status ?? task.status);
		for (const token of changes.assignees ?? task.assignees.map(assigneeToken)) body.append('assignees', token);

		const res = await fetch(`/api/tasks/${task.id}/update`, { method: 'POST', body });

		if (!res.ok) {
			rowError = { id: task.id, message: await res.text() };
			savingId = null;
			return false;
		}

		updateTask(await res.json());
		savingId = null;
		return true;
	}

	// Closes the field on success only: a rejected save keeps the draft on screen with
	// the reason under it, rather than throwing the typing away.
	async function commitField(task: Task, changes: Parameters<typeof saveField>[1]) {
		if (await saveField(task, changes)) editingField = null;
	}

	async function toggleDone(task: Task) {
		togglingId = task.id;
		await saveField(task, { status: task.status === 'done' ? 'ongoing' : 'done' });
		togglingId = null;
	}

	// Appointments have no check/cancel of their own — the ✕ and + are the action, and
	// each one saves on the click. The list stays open afterwards so several people can
	// be added in a row.
	async function toggleAppointee(task: Task, token: string, on: boolean) {
		const current = task.assignees.map(assigneeToken);
		await saveField(task, { assignees: on ? [...current, token] : current.filter((t) => t !== token) });
	}

	// Every party the task could be appointed to: project members, ghost members, and
	// the former members it still carries an appointment for (those can only be
	// removed — there's no account left to appoint again).
	function appointOptions(task: Task) {
		const appointed = new Set(task.assignees.map(assigneeToken));
		return [
			...members.map((m) => ({ token: m.id, displayName: m.displayName, avatar: m.avatar })),
			...ghostMembers.map((g) => ({ token: ghostPartyId(g.id), displayName: g.displayName, avatar: null })),
			...task.assignees
				.filter((a) => !a.user_id && !a.ghost_member_id)
				.map((a) => ({ token: assigneeToken(a), displayName: a.display_name, avatar: null })),
		].map((option) => ({ ...option, appointed: appointed.has(option.token) }));
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
		addDeadlineTime = DEFAULT_DEADLINE_TIME;
		addStatus = 'ongoing';
		addAssignees = [];
		showAddForm = false;
		adding = false;
	}

	// The whole project's tasks, not `visibleTasks` — the meta line above follows the
	// "Just my tasks" filter because it describes the list, but a file called
	// '<project> - tasks.json' that quietly held a third of them would be a trap.
	// Sorted the way the page sorts (deadline first), so the file reads in the same
	// order as the screen.
	function downloadTasks() {
		const payload = {
			project: projectName,
			exportedAt: new Date().toISOString(),
			taskCount: tasksState.tasks.length,
			tasks: tasksState.tasks.map((task) => ({
				id: task.id,
				name: task.name,
				category: task.category,
				description: task.description,
				deadline: task.deadline,
				deadlineTime: task.deadline_time,
				status: task.status,
				// Names, not ids: a ghost member and a former member have no user_id to
				// look up, and the point of the export is to be readable on its own.
				assignees: task.assignees.map((a) => a.display_name),
			})),
		};

		downloadJson(exportFilename(projectName, 'tasks', 'json'), payload);
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

		{@render colorSwatches(effective)}
		{#if colorError}<span class="swatch-error">{colorError}</span>{/if}
	</div>
{/snippet}

<!-- Ten fixed slots. The active one is whichever the category resolves to right now,
     picked or hashed, so the row always shows the colour the list and the calendar are
     actually painting rather than 'nothing chosen'. -->
{#snippet colorSwatches(effective: string)}
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
{/snippet}

<!-- The three icon buttons the panel edits are driven by: the pencil that opens a
     field, and the check/✕ pair that closes it. Buttons rather than links so they're
     tabbable in place, and 20px squares so a line of text keeps its height. -->
{#snippet editIcon(label: string, onclick: () => void)}
	<button type="button" class="icon-btn icon-edit" title={label} aria-label={label} onclick={onclick}>
		<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
			<path d="M11.1 1.4a1.4 1.4 0 0 1 2 0l1.5 1.5a1.4 1.4 0 0 1 0 2l-.9.9-3.5-3.5zM9.3 3.2l3.5 3.5-6.6 6.6-3.5.7.7-3.5z" />
		</svg>
	</button>
{/snippet}

{#snippet confirmIcons(onSave: () => void, busy: boolean)}
	<span class="confirm-icons">
		<button type="button" class="icon-btn icon-ok" title="Save" aria-label="Save" onclick={onSave} disabled={busy}>
			<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
				<path d="M6.2 12.4 2 8.2l1.4-1.4 2.8 2.8 6.4-6.4L14 4.6z" />
			</svg>
		</button>
		<button type="button" class="icon-btn icon-cancel" title="Cancel" aria-label="Cancel" onclick={cancelField} disabled={busy}>
			<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
				<path d="M12.7 4.7 9.4 8l3.3 3.3-1.4 1.4L8 9.4l-3.3 3.3-1.4-1.4L6.6 8 3.3 4.7l1.4-1.4L8 6.6l3.3-3.3z" />
			</svg>
		</button>
	</span>
{/snippet}

{#snippet assigneeField(selected: string[], onToggle: (id: string, on: boolean) => void, deletedAssignees: Task['assignees'] = [])}
	<div class="field field-wide">
		<span class="field-label">Appointed members</span>
		{#if members.length === 0 && ghostMembers.length === 0 && deletedAssignees.length === 0}
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
				<!-- Ghost members appoint the same way a real member does, just keyed by
				     money-parties.ts's `ghost:<id>` token instead of a bare user id — see
				     task-form.ts's taskAssigneeColumns. -->
				{#each ghostMembers as ghost (ghost.id)}
					{@const token = ghostPartyId(ghost.id)}
					<label class="assignee-option">
						<input
							type="checkbox"
							name="assignees"
							value={token}
							checked={selected.includes(token)}
							onchange={(e) => onToggle(token, (e.currentTarget as HTMLInputElement).checked)}
						/>
						<span>{ghost.displayName}</span>
					</label>
				{/each}
				<!-- A deleted account's appointment: not a project member anymore (they're
				     gone from `members` along with their whole account), but the row
				     survives until this checkbox is unticked and saved — see
				     task-columns.ts and the update endpoint's diff. -->
				{#each deletedAssignees as assignee (assignee.id)}
					{@const token = assigneeToken(assignee)}
					<label class="assignee-option">
						<input
							type="checkbox"
							name="assignees"
							value={token}
							checked={selected.includes(token)}
							onchange={(e) => onToggle(token, (e.currentTarget as HTMLInputElement).checked)}
						/>
						<span>{assignee.display_name}</span>
					</label>
				{/each}
			</div>
		{/if}
	</div>
{/snippet}

<!-- Appointed members are pictures only — a name would double the width of the
     column for something the hover title (and the edit form's picker) already says.
     A ghost or a deleted account has no avatar and falls back to its initial.
     `limit` caps how many faces show before the rest collapse into a +N chip whose
     hover title names them; 0 means show every one, which is what the detail panel
     below passes since it has the width to spare. -->
{#snippet assigneeAvatars(task: Task, limit: number)}
	{#if task.assignees.length === 0}
		<span class="muted">—</span>
	{:else}
		{@const shown = limit > 0 ? task.assignees.slice(0, limit) : task.assignees}
		{@const rest = task.assignees.slice(shown.length)}
		<span class="assignee-avatars">
			{#each shown as assignee (assignee.id)}
				<span class="assignee-avatar" title={assignee.display_name}>
					<Avatar avatar={assignee.avatar} displayName={assignee.display_name} size={22} />
				</span>
			{/each}
			{#if rest.length > 0}
				<span class="assignee-more" title={rest.map((a) => a.display_name).join(', ')}>
					+{rest.length}
				</span>
			{/if}
		</span>
	{/if}
{/snippet}

<!-- The three below are shared by the list rows and the calendar's selected-task
     panel: the calendar has no row of its own to hang them off, and two copies of an
     edit form is exactly how the two views would drift apart. -->
{#snippet taskActions(task: Task)}
	<div class="cell-actions">
		<!-- Reopen rather than a second Done: the button has to say what the click will
		     do. No Edit button — editing is per-field inside the panel below. -->
		<button type="button" class="btn-plain" onclick={() => toggleDone(task)} disabled={togglingId === task.id}>
			{togglingId === task.id ? '…' : task.status === 'done' ? 'Reopen' : 'Done'}
		</button>
		<button type="button" class="btn-danger" onclick={() => handleDelete(task.id)} disabled={deletingId === task.id}>
			{deletingId === task.id ? '…' : 'Delete'}
		</button>
	</div>
{/snippet}

<!-- The panel is both the read view and the edit surface: every value carries a pencil
     that swaps that one line for its input, and nothing else on the panel moves while
     it's open — the controls are sized to the line height they replace. -->
{#snippet detailBody(task: Task)}
	{@const busy = savingId === task.id}
	<dl class="detail">
		<dt>Name</dt>
		<dd>
			{#if isEditing(task.id, 'name')}
				<div class="detail-line">
					<input class="inline-input" type="text" maxlength="200" bind:value={draftName} aria-label="Task name" />
					{@render confirmIcons(() => commitField(task, { name: draftName.trim() }), busy)}
				</div>
			{:else}
				<div class="detail-line">
					<span>{task.name}</span>
					{#if canEdit}{@render editIcon('Edit name', () => startField(task, 'name'))}{/if}
				</div>
			{/if}
		</dd>

		<dt>Category</dt>
		<dd>
			{#if isEditing(task.id, 'category')}
				<!-- The select stands exactly where the chip was and the swatches sit to its
				     right, so opening this doesn't reflow the rows under it. -->
				<div class="detail-line">
					<select class="inline-select" aria-label="Category" bind:value={editCategorySelect}>
						<option value="">None</option>
						{#each existingCategories as cat (cat)}
							<option value={cat}>{cat}</option>
						{/each}
						<option value={NEW_CATEGORY_VALUE}>+ Add category</option>
					</select>
					{#if editCategorySelect === NEW_CATEGORY_VALUE}
						<input
							class="inline-input"
							type="text"
							placeholder="New category name"
							maxlength="100"
							bind:value={editCategoryNew}
						/>
					{/if}
					{@render colorSwatches(editCategoryEffective)}
					{@render confirmIcons(() => commitField(task, { category: editCategoryEffective.trim() }), busy)}
				</div>
				{#if colorError}<span class="swatch-error">{colorError}</span>{/if}
			{:else}
				<div class="detail-line">
					{#if task.category?.trim()}
						<span class="category-chip" style={styleFor(task.category)}>{task.category.trim()}</span>
					{:else}
						<span>—</span>
					{/if}
					{#if canEdit}{@render editIcon('Edit category', () => startField(task, 'category'))}{/if}
				</div>
			{/if}
		</dd>

		<dt>Appointed</dt>
		<dd>
			{#if isEditing(task.id, 'appointed')}
				<!-- Everyone the task could be appointed to, in one list: the appointed ones
				     in full colour with a ✕, the rest greyed with a +. Each click saves on
				     its own, so there's no check/cancel pair here — the pencil closes it. -->
				<div class="appoint-list">
					{#each appointOptions(task) as option (option.token)}
						<div class="appoint-row">
							<span class="appoint-who" class:off={!option.appointed}>
								<Avatar avatar={option.avatar} displayName={option.displayName} size={22} />
								<span class="appoint-name">{option.displayName}</span>
							</span>
							{#if option.appointed}
								<button
									type="button"
									class="icon-btn icon-remove"
									title={`Remove ${option.displayName}`}
									aria-label={`Remove ${option.displayName}`}
									disabled={busy}
									onclick={() => toggleAppointee(task, option.token, false)}
								>
									<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
										<path d="M12.7 4.7 9.4 8l3.3 3.3-1.4 1.4L8 9.4l-3.3 3.3-1.4-1.4L6.6 8 3.3 4.7l1.4-1.4L8 6.6l3.3-3.3z" />
									</svg>
								</button>
							{:else}
								<button
									type="button"
									class="icon-btn icon-add"
									title={`Appoint ${option.displayName}`}
									aria-label={`Appoint ${option.displayName}`}
									disabled={busy}
									onclick={() => toggleAppointee(task, option.token, true)}
								>
									<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
										<path d="M7 2h2v5h5v2H9v5H7V9H2V7h5z" />
									</svg>
								</button>
							{/if}
						</div>
					{:else}
						<span class="muted">No members to appoint.</span>
					{/each}
				</div>
			{:else}
				<div class="detail-line">
					{@render assigneeAvatars(task, 0)}
					{#if canEdit}{@render editIcon('Edit appointed members', () => startField(task, 'appointed'))}{/if}
				</div>
			{/if}
		</dd>

		<dt>Deadline</dt>
		<dd>
			{#if isEditing(task.id, 'deadline')}
				<div class="detail-line">
					<div class="deadline-inputs">
						<input class="inline-input" type="date" bind:value={draftDeadline} aria-label="Deadline date" />
						<input class="inline-input" type="time" bind:value={draftDeadlineTime} aria-label="Deadline time" />
					</div>
					{@render confirmIcons(
						() => commitField(task, { deadline: draftDeadline, deadline_time: draftDeadlineTime }),
						busy,
					)}
				</div>
			{:else}
				<div class="detail-line">
					{#if task.deadline}
						<span>
							{formatDeadline(task.deadline, today)}, {formatDeadlineTime(task.deadline_time)}
							<span class="muted">({relativeDeadline(task.deadline, today)})</span>
						</span>
					{:else}
						<span>—</span>
					{/if}
					{#if canEdit}{@render editIcon('Edit deadline', () => startField(task, 'deadline'))}{/if}
				</div>
			{/if}
		</dd>

		<dt>Description</dt>
		<dd>
			{#if isEditing(task.id, 'description')}
				<!-- The one field with worded buttons rather than icons: it's a multi-line
				     box, so its controls sit under it where there's room for words. -->
				<div class="description-edit">
					<textarea class="inline-textarea" rows="4" maxlength="1000" bind:value={draftDescription} aria-label="Description"
					></textarea>
					<div class="inline-actions">
						<button type="button" disabled={busy} onclick={() => commitField(task, { description: draftDescription })}>
							{busy ? 'Saving…' : 'Save'}
						</button>
						<button type="button" class="btn-plain" disabled={busy} onclick={cancelField}>Cancel</button>
					</div>
				</div>
			{:else}
				<div class="detail-line">
					<span>{task.description || '—'}</span>
					{#if canEdit}{@render editIcon('Edit description', () => startField(task, 'description'))}{/if}
				</div>
			{/if}
		</dd>
	</dl>

	{#if rowError?.id === task.id}<p class="panel-error">{rowError.message}</p>{/if}
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

		<!-- Not gated on canEdit: a viewer can read every task on the page already, so
		     there's nothing in the file they couldn't copy out by hand. -->
		<button
			type="button"
			class="btn-plain head-btn"
			onclick={downloadTasks}
			disabled={tasksState.tasks.length === 0}
			title="Download all tasks as JSON"
		>Download</button>

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
					<div class="deadline-inputs">
						<input type="date" name="deadline" bind:value={addDeadline} />
						<input type="time" name="deadline_time" bind:value={addDeadlineTime} aria-label="Deadline time" />
					</div>
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
		<TasksCalendar tasks={visibleTasks} today={today} nowTime={nowTime} colorFor={styleForTask} onSelect={toggleDetail} selectedId={openId} />

		<!-- The grid has no rows, so the open task's panel lands under it — with the
		     row controls it would otherwise have nowhere to live. -->
		{#if selectedTask}
			<!-- Carries the `#task-<id>` anchor in this mode: the grid has no row to put it
			     on, and a linked task's deadline may not even be in the month on screen,
			     but its panel always renders here. -->
			<div class="task-panel calendar-panel" id={`task-${selectedTask.id}`} transition:slide={{ duration: 150 }}>
				<div class="panel-head">
					<strong class="panel-title" class:done={statusOf(selectedTask) === 'done'}>{selectedTask.name}</strong>
					<span class="status status-{statusOf(selectedTask)}">{TASK_STATUS_LABELS[statusOf(selectedTask)]}</span>
					{#if canEdit}{@render taskActions(selectedTask)}{/if}
				</div>
				{@render detailBody(selectedTask)}
			</div>
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
				<span>Appointed</span>
				<span>Deadline</span>
				<span class="head-status">Status</span>
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

								<!-- Two faces, then a +N chip that names the rest on hover — the
								     detail panel below shows every one. -->
								<div class="cell cell-people">{@render assigneeAvatars(task, 2)}</div>

								<!-- Date and time on the one line: the relative form ('in 3 days')
								     moved to the detail panel, since the date already says it. -->
								<div class="cell cell-deadline">
									{#if task.deadline}
										{formatDeadline(task.deadline, today)}, {formatDeadlineTime(task.deadline_time)}
									{:else}
										<span class="task-sub">no deadline</span>
									{/if}
								</div>

								<!-- The status is a dot, not a word: three states in a fixed set read
								     faster as colour, and the label stays as its hover title and its
								     accessible name. -->
								<div class="cell cell-status">
									<span
										class="status-dot status-{status}"
										title={TASK_STATUS_LABELS[status]}
										aria-label={TASK_STATUS_LABELS[status]}
										role="img"
									></span>
								</div>

								<!-- Overlaid on the row's right edge rather than holding a column of
								     its own: the controls only matter for the row under the pointer,
								     and a permanent 170px track for them was most of the row's
								     bloat. Still in the DOM at all times so the keyboard reaches
								     them (:focus-within reveals it) — hidden ones are inert instead
								     of absent. -->
								{#if canEdit}
									<div class="cell-actions-wrap">{@render taskActions(task)}</div>
								{/if}
							</div>

							{#if openId === task.id}
								<div class="task-panel" transition:slide={{ duration: 150 }}>
									{@render detailBody(task)}
								</div>
							{/if}

							<!-- A row-level failure (Done, Delete) with no panel open to carry it. -->
							{#if rowError?.id === task.id && openId !== task.id}
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

	.add-toggle,
	.head-btn {
		padding: var(--space-1) var(--space-3);
		font-size: 0.8rem;
	}

	.head-btn {
		flex: 0 0 auto;
	}

	.empty {
		font-size: 0.85rem;
	}

	/* List */

	/* The deadline track fits 'September 27, 11:59 PM' on one line at the cell's font
	   size, with the year only ever added for a deadline outside this one — where a
	   little truncation is the right trade for keeping every other row tight. The
	   status track is only as wide as its dot. */
	.task-list {
		--task-cols: minmax(0, 1.2fr) minmax(0, 0.8fr) 178px 14px;
		/* What the row reserves on its right edge while its controls are showing — the
		   width of the two buttons (Edit having moved into the panel), so they land in
		   space of their own rather than on top of the cells. Sized against the *wider*
		   toggle label ('Reopen'), which the min-width below makes every row's. */
		--row-actions: 126px;
		border-top: 1px solid var(--color-border);
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
		position: relative;
		padding: var(--space-2);
		cursor: pointer;
		transition: background 0.12s ease, padding-right 0.12s ease;
	}

	.task-row:hover,
	.task-item.open .task-row {
		background: var(--color-highlight);
	}

	/* The cells give the controls room instead of being covered by them: the extra
	   right padding narrows the two flexible tracks, which slides everything left as
	   the buttons come in. Only the rows do this — the head keeps its own widths, so
	   the column labels stay put while the row under the pointer shifts. */
	.task-list.with-actions .task-row:hover,
	.task-list.with-actions .task-row:focus-within,
	.task-list.with-actions .task-item.open .task-row {
		padding-right: calc(var(--space-2) + var(--row-actions));
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

	.cell-people {
		color: var(--color-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* The row aligns on the text baseline, which a row of pictures doesn't have — this
	   centres the faces against the line instead of hanging them off it. */
	.cell-people {
		align-self: center;
	}

	/* In the row the faces stay on the one line and clip like the description does; in
	   the detail panel below they may wrap, since there's height to spare there. */
	.cell-people .assignee-avatars {
		flex-wrap: nowrap;
	}

	.assignee-avatars {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		flex-wrap: wrap;
	}

	.assignee-avatar {
		display: flex;
		border-radius: 50%;
		box-shadow: 0 0 0 1px var(--color-border);
	}

	/* Same 22px circle as a face, so the row of avatars keeps its rhythm when the
	   overflow chip stands in for the last of them. */
	.assignee-more {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 22px;
		height: 22px;
		border-radius: 50%;
		box-shadow: 0 0 0 1px var(--color-border);
		background: var(--color-highlight-strong);
		color: var(--color-fg);
		font-size: 0.62rem;
		font-weight: 700;
		line-height: 1;
		cursor: default;
	}

	/* One line whatever the month is called: a wrap here would put back the height the
	   row just gave up. */
	.cell-deadline {
		font-variant-numeric: tabular-nums;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* The dot's track is only as wide as the dot, so the column's heading would spill
	   into the one beside it — it stays for screen readers only. */
	.head-status {
		overflow: hidden;
		white-space: nowrap;
		text-indent: -9999px;
	}

	/* Takes its fill from the same .status-* colours the panel's text label uses, so
	   the two views can never disagree about what overdue looks like. */
	.status-dot {
		display: block;
		align-self: center;
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: currentColor;
	}

	.cell-status {
		display: flex;
		align-items: center;
		align-self: center;
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

	/* Green is the live state, grey the finished one: a task still being worked on is
	   what the list is for, and a done one is settled and out of the way. */
	.status-done {
		color: var(--color-muted);
	}

	.status-ongoing {
		color: var(--color-success);
	}

	.cell-actions {
		display: flex;
		gap: var(--space-1);
		justify-content: flex-end;
	}

	/* Fixed width rather than sized to the label: the toggle says 'Done' on one row and
	   'Reopen' on the next, and a block that's right-aligned inside a fixed reserve grew
	   leftwards under the wider word — so the gap between the status dot and the button
	   changed from row to row, and on a done row the button ran into the dot. Both
	   buttons take the same box now, so the pair sits in the same place on every row. */
	.cell-actions button {
		flex: 0 0 auto;
		min-width: 58px;
		white-space: nowrap;
		padding: 0 var(--space-2);
		font-size: 0.7rem;
		line-height: 1.8;
	}

	/* Slides into the gap the row's padding opens for it on hover. Absolute rather than
	   a grid track of its own so the head above keeps its column widths whatever the
	   row beneath is doing. `visibility` rides the same transition so the hidden state
	   is not just invisible but untabbable, which `opacity: 0` alone would not be. */
	.cell-actions-wrap {
		position: absolute;
		top: 50%;
		right: var(--space-2);
		width: var(--row-actions);
		opacity: 0;
		visibility: hidden;
		transform: translate(var(--space-3), -50%);
		transition: opacity 0.12s ease, transform 0.12s ease, visibility 0.12s;
	}

	/* Also while the row's panel is open: the controls belong to whatever task is being
	   looked at, and the pointer has usually left the row by then. */
	.task-row:hover .cell-actions-wrap,
	.task-row:focus-within .cell-actions-wrap,
	.task-item.open .cell-actions-wrap {
		opacity: 1;
		visibility: visible;
		transform: translate(0, -50%);
	}

	@media (prefers-reduced-motion: reduce) {
		.cell-actions-wrap {
			transition: none;
			transform: translate(0, -50%);
		}
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

	/* A value and its pencil (or its inputs and their check/✕) on one line. The line's
	   min-height is the read state's own height, so swapping in a control can't push
	   the rows under it around. */
	.detail-line {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-2);
		min-height: 1.65rem;
	}

	/* Only shows once its line is hovered or the button itself is focused — a column of
	   pencils down the panel would read as the loudest thing on it. */
	.icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 20px;
		height: 20px;
		padding: 0;
		background: none;
		border: 1px solid transparent;
		color: var(--color-muted);
		cursor: pointer;
	}

	.icon-btn svg {
		width: 11px;
		height: 11px;
		fill: currentColor;
	}

	.icon-btn:hover:not(:disabled) {
		border-color: var(--color-border);
		color: var(--color-fg);
	}

	.icon-btn:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.detail-line .icon-edit:not(:focus-visible) {
		opacity: 0;
	}

	.detail-line:hover .icon-edit {
		opacity: 1;
	}

	/* No hover to reveal them with on a touch screen. */
	@media (hover: none) {
		.detail-line .icon-edit {
			opacity: 1;
		}
	}

	.confirm-icons {
		display: inline-flex;
		gap: var(--space-1);
		flex: 0 0 auto;
	}

	/* The save/cancel pair and the appoint/remove pair keep their colour at rest —
	   unlike the pencil, they're the only thing to do once a field is open. */
	.icon-ok,
	.icon-add {
		color: var(--color-success);
	}

	.icon-cancel,
	.icon-remove {
		color: var(--color-danger);
	}

	.icon-ok:hover:not(:disabled),
	.icon-add:hover:not(:disabled) {
		color: var(--color-success);
	}

	.icon-cancel:hover:not(:disabled),
	.icon-remove:hover:not(:disabled) {
		color: var(--color-danger);
	}

	/* Sized down to the line they stand in rather than the panel's form controls, so an
	   open field is the same height as the text it replaced. */
	.inline-input,
	.inline-select {
		min-width: 0;
		padding: 0 var(--space-1);
		font-size: 0.78rem;
		line-height: 1.5;
	}

	.inline-select {
		max-width: 220px;
	}

	.inline-input[type='text'] {
		width: 100%;
		max-width: 320px;
	}

	.appoint-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 2px 0;
	}

	.appoint-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-size: 0.8rem;
	}

	.appoint-who {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
	}

	/* Greyed, not hidden: an unappointed member is still a name you're picking from. */
	.appoint-who.off {
		opacity: 0.45;
	}

	.appoint-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.description-edit {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: 2px 0;
	}

	.inline-textarea {
		width: 100%;
		max-width: 520px;
		padding: var(--space-1) var(--space-2);
		font: inherit;
		font-size: 0.82rem;
		resize: vertical;
	}

	.inline-actions {
		display: flex;
		gap: var(--space-2);
	}

	.inline-actions button {
		padding: var(--space-1) var(--space-3);
		font-size: 0.78rem;
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

	/* The time box is sized to its own content so the date box takes whatever's left —
	   the reverse leaves the date truncated at the panel grid's 180px track, which is
	   the half nobody can read from a truncated string. */
	.deadline-inputs {
		display: flex;
		gap: var(--space-1);
		min-width: 0;
	}

	.deadline-inputs input[type='time'] {
		width: auto;
		flex: 0 0 auto;
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
	   and its status dot head it, then appointment and deadline stacked under it,
	   controls last. */
	@media (max-width: 900px) {
		.list-head {
			display: none;
		}

		.task-list {
			--task-cols: minmax(0, 1fr) auto;
		}

		.task-row {
			row-gap: var(--space-1);
			align-items: start;
		}

		/* Pinned beside the name rather than left to auto-placement, which would give a
		   lone dot a row of its own under the stacked cells. */
		.cell-status {
			grid-column: 2;
			grid-row: 1;
			align-self: start;
			padding-top: 4px;
		}

		.cell-people,
		.cell-deadline {
			grid-column: 1 / -1;
			font-size: 0.76rem;
		}

		/* There is no hover on a touch screen, so the controls come back out of the
		   overlay and sit under the row as their own line. */
		.cell-actions-wrap {
			position: static;
			grid-column: 1 / -1;
			width: auto;
			margin-top: var(--space-1);
			opacity: 1;
			visibility: visible;
			transform: none;
		}

		/* The reveal rules above still match on a hybrid device; without this their
		   translate(0, -50%) would lift the now-static block half its own height, and
		   the row would keep reserving a gap for controls that are no longer in it. */
		.task-row:hover .cell-actions-wrap,
		.task-row:focus-within .cell-actions-wrap,
		.task-item.open .cell-actions-wrap {
			transform: none;
		}

		.task-list.with-actions .task-row:hover,
		.task-list.with-actions .task-row:focus-within,
		.task-list.with-actions .task-item.open .task-row {
			padding-right: var(--space-2);
		}

		.cell-actions-wrap .cell-actions {
			justify-content: flex-start;
		}
	}
</style>
