<script lang="ts">
	import { slide } from 'svelte/transition';

	interface Member {
		user_id: string;
		role: string;
		is_auditor: boolean;
		display_name: string;
	}

	let {
		projectId,
		members: initialMembers,
	}: {
		projectId: string;
		members: Member[];
	} = $props();

	let members = $state(initialMembers);

	// Grouped by role instead of colour-coded — owner first, then editors, then
	// viewers; unknown roles (if the check constraint grows) fall in after those.
	const ROLE_ORDER = ['owner', 'editor', 'viewer'];
	const ROLE_LABELS: Record<string, string> = { owner: 'Owner', editor: 'Editors', viewer: 'Viewers' };

	function roleRank(role: string) {
		const i = ROLE_ORDER.indexOf(role);
		return i === -1 ? ROLE_ORDER.length : i;
	}

	const groups = $derived(
		[...new Set(members.map((m) => m.role))]
			.sort((a, b) => roleRank(a) - roleRank(b))
			.map((role) => ({
				role,
				label: ROLE_LABELS[role] ?? role,
				members: members.filter((m) => m.role === role),
			})),
	);

	// user_id of the member whose edit panel is open, or null when closed.
	let editingId = $state<string | null>(null);
	let draftRole = $state('editor');
	let draftAuditor = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);

	function toggleEdit(member: Member) {
		if (editingId === member.user_id) {
			editingId = null;
			return;
		}
		editingId = member.user_id;
		draftRole = member.role;
		draftAuditor = member.is_auditor;
		error = null;
	}

	function cancelEdit() {
		if (busy) return;
		editingId = null;
		error = null;
	}

	async function save() {
		if (!editingId) return;
		busy = true;
		error = null;

		const body = new URLSearchParams();
		body.set('userId', editingId);
		body.set('role', draftRole);
		if (draftAuditor) body.set('isAuditor', 'on');

		const res = await fetch(`/api/projects/${projectId}/members`, {
			method: 'POST',
			body,
		});

		if (!res.ok) {
			error = await res.text();
			busy = false;
			return;
		}

		members = members.map((m) =>
			m.user_id === editingId ? { ...m, role: draftRole, is_auditor: draftAuditor } : m,
		);
		busy = false;
		editingId = null;
	}

	async function remove(member: Member) {
		if (!confirm(`Remove ${member.display_name} from this project?`)) return;
		busy = true;
		error = null;

		const res = await fetch(`/api/projects/${projectId}/members/${member.user_id}/delete`, {
			method: 'POST',
		});

		if (!res.ok) {
			error = await res.text();
			busy = false;
			return;
		}

		members = members.filter((m) => m.user_id !== member.user_id);
		busy = false;
		editingId = null;
	}
</script>

{#snippet editPanel(member: Member)}
	<div class="edit-panel" transition:slide={{ duration: 150 }}>
		<label class="field">
			<span>Role</span>
			<select bind:value={draftRole}>
				<option value="editor">Editor</option>
				<option value="viewer">Viewer</option>
			</select>
		</label>

		<label class="auditor-field">
			<input type="checkbox" bind:checked={draftAuditor} />
			<span>Auditor <span class="muted">— can edit the Money page</span></span>
		</label>

		{#if error}<p class="row-error">{error}</p>{/if}

		<div class="panel-actions">
			<button type="button" onclick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
			<button type="button" class="btn-plain" onclick={cancelEdit} disabled={busy}>Cancel</button>
		</div>
		<button type="button" class="btn-danger remove-btn" onclick={() => remove(member)} disabled={busy}>
			Remove from project
		</button>
	</div>
{/snippet}

<div class="member-groups">
	{#each groups as group (group.role)}
		<div class="member-group">
			<p class="group-label">{group.label}</p>
			<ul class="member-list">
				{#each group.members as m (m.user_id)}
					<li class="member-row">
						<div class="member-header">
							<span class="member-name">
								{m.display_name}{#if m.is_auditor}<span class="capability"> [auditor]</span>{/if}
							</span>
							{#if m.role !== 'owner'}
								<button
									type="button"
									class="edit-icon"
									aria-label={`Edit ${m.display_name}'s role`}
									onclick={() => toggleEdit(m)}
								>✎</button>
							{/if}
						</div>

						{#if editingId === m.user_id}
							{@render editPanel(m)}
						{/if}
					</li>
				{/each}
			</ul>
		</div>
	{/each}
</div>

<style>
	.member-groups {
		margin: 0 0 var(--space-3);
	}

	.member-group + .member-group {
		margin-top: var(--space-3);
	}

	.group-label {
		margin: 0 0 var(--space-1);
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--color-muted);
	}

	.member-list {
		list-style: none;
		margin: 0;
		padding: 0;
		min-width: 0;
	}

	.member-row {
		margin-bottom: var(--space-1);
		min-width: 0;
	}

	.member-header {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
	}

	.member-name {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		min-width: 0;
	}

	.capability {
		color: var(--color-muted);
	}

	.edit-icon {
		flex: 0 0 auto;
		background: none;
		border: none;
		padding: 0;
		color: var(--color-fg);
		font-size: 0.9rem;
		line-height: 1;
		cursor: pointer;
	}

	.edit-icon:hover {
		opacity: 0.6;
	}

	.edit-panel {
		margin-top: var(--space-2);
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		color: var(--color-fg);
		background: var(--color-bg);
		border: 1px solid var(--color-border-strong);
		padding: var(--space-3);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	.field select {
		width: 100%;
	}

	.auditor-field {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
	}

	.auditor-field input {
		width: auto;
		flex: 0 0 auto;
		margin-top: 2px;
	}

	.muted {
		color: var(--color-muted);
	}

	.panel-actions {
		display: flex;
		gap: var(--space-2);
	}

	.panel-actions button {
		flex: 1;
	}

	.row-error {
		color: var(--color-danger);
		margin: 0;
	}

	.remove-btn {
		width: 100%;
	}
</style>
