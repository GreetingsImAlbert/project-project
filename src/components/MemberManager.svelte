<script lang="ts">
	import { onMount } from 'svelte';

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

	// user_id of the member whose edit modal is open, or null when closed.
	let editingId = $state<string | null>(null);
	let draftRole = $state('editor');
	let draftAuditor = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);

	let editingMember = $derived(members.find((m) => m.user_id === editingId) ?? null);

	function openEdit(member: Member) {
		editingId = member.user_id;
		draftRole = member.role;
		draftAuditor = member.is_auditor;
		error = null;
	}

	function closeEdit() {
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

	onMount(() => {
		function onKeydown(e: KeyboardEvent) {
			if (e.key === 'Escape') closeEdit();
		}
		window.addEventListener('keydown', onKeydown);
		return () => window.removeEventListener('keydown', onKeydown);
	});
</script>

<ul class="member-list">
	{#each members as m (m.user_id)}
		<li class={`member-row role-${m.role}`}>
			<span class="member-name">
				{m.display_name} ({m.role}){#if m.is_auditor}<span class="auditor-badge"> · auditor</span>{/if}
			</span>
			{#if m.role !== 'owner'}
				<button
					type="button"
					class="edit-icon"
					aria-label={`Edit ${m.display_name}'s role`}
					onclick={() => openEdit(m)}
				>✎</button>
			{/if}
		</li>
	{/each}
</ul>

{#if editingMember}
	<div class="modal-backdrop" onclick={closeEdit}>
		<div class="modal-box" role="dialog" aria-modal="true" onclick={(e) => e.stopPropagation()}>
			<p class="modal-title">{editingMember.display_name}</p>

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

			<div class="modal-actions">
				<button type="button" onclick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
				<button type="button" class="btn-plain" onclick={closeEdit} disabled={busy}>Cancel</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.member-list {
		list-style: none;
		margin: 0 0 var(--space-3);
		padding: 0;
		min-width: 0;
	}

	.member-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin-bottom: var(--space-1);
		min-width: 0;
	}

	.member-name {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		min-width: 0;
	}

	.member-row.role-owner {
		color: var(--color-role-owner);
	}

	.member-row.role-editor {
		color: var(--color-role-editor);
	}

	.member-row.role-viewer {
		color: var(--color-role-viewer);
	}

	.auditor-badge {
		color: var(--color-role-auditor);
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

	.modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.4);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-4);
		z-index: 100;
	}

	.modal-box {
		background: var(--color-bg);
		border: 1px solid var(--color-border-strong);
		padding: var(--space-5);
		width: 100%;
		max-width: 360px;
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	.modal-title {
		font-weight: 700;
		margin: 0;
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

	.modal-actions {
		display: flex;
		gap: var(--space-2);
	}

	.modal-actions button {
		flex: 1;
	}

	.row-error {
		color: var(--color-danger);
		margin: 0;
	}
</style>
