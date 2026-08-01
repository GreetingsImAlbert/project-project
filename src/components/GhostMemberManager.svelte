<script lang="ts">
	import { slide } from 'svelte/transition';
	import Avatar from './Avatar.svelte';

	interface GhostMember {
		id: string;
		display_name: string;
		note: string | null;
		is_deleted_account: boolean;
	}

	let {
		projectId,
		ghostMembers: initialGhostMembers,
	}: {
		projectId: string;
		ghostMembers: GhostMember[];
	} = $props();

	let ghostMembers = $state(initialGhostMembers);
	let editingId = $state<string | null>(null);
	let draftName = $state('');
	let draftNote = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	function startEdit(ghost: GhostMember) {
		editingId = ghost.id;
		draftName = ghost.display_name;
		draftNote = ghost.note ?? '';
		error = null;
	}

	function cancelEdit() {
		if (busy) return;
		editingId = null;
		error = null;
	}

	async function save(ghost: GhostMember) {
		busy = true;
		error = null;

		const formData = new FormData();
		formData.set('displayName', draftName);
		formData.set('note', draftNote);

		const res = await fetch(`/api/projects/${projectId}/ghost-members/${ghost.id}/update`, {
			method: 'POST',
			body: formData,
		});

		if (!res.ok) {
			error = await res.text();
			busy = false;
			return;
		}

		const updated: { display_name: string; note: string | null } = await res.json();
		ghostMembers = ghostMembers.map((item) =>
			item.id === ghost.id ? { ...item, display_name: updated.display_name, note: updated.note } : item,
		);
		busy = false;
		editingId = null;
	}

	async function remove(ghost: GhostMember) {
		if (!confirm(`Remove ${ghost.display_name} from this project?`)) return;

		busy = true;
		error = null;

		const res = await fetch(`/api/projects/${projectId}/ghost-members/${ghost.id}/delete`, {
			method: 'POST',
		});

		if (!res.ok) {
			error = await res.text();
			busy = false;
			return;
		}

		ghostMembers = ghostMembers.filter((item) => item.id !== ghost.id);
		busy = false;
		editingId = null;
	}
</script>

{#if ghostMembers.length > 0}
	<div class="member-groups">
		<div class="member-group">
			<p class="group-label">Ghosts</p>
			<ul class="member-list">
				{#each ghostMembers as ghost (ghost.id)}
					<li class="member-row">
						<div class="member-header">
							<span class="member-avatar">
								<Avatar avatar={null} displayName={ghost.display_name} size={24} />
							</span>
							<span class="member-name" title={ghost.note ?? undefined}>
								{ghost.display_name}{#if ghost.is_deleted_account}<span class="capability"> [deleted]</span>{/if}
							</span>
							<button
								type="button"
								class="edit-icon"
								aria-label={`Edit ${ghost.display_name}`}
								onclick={() => startEdit(ghost)}
								disabled={busy}
							>✎</button>
						</div>

						{#if editingId === ghost.id}
							<div class="edit-panel" transition:slide={{ duration: 150 }}>
								<label class="field">
									<span>Name</span>
									<input type="text" bind:value={draftName} maxlength="80" required />
								</label>
								<label class="field">
									<span>Note</span>
									<input type="text" bind:value={draftNote} maxlength="200" placeholder="Who they are (optional)" />
								</label>
								{#if error}<p class="row-error">{error}</p>{/if}
								<div class="panel-actions">
									<button type="button" onclick={() => save(ghost)} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
									<button type="button" class="btn-plain" onclick={cancelEdit} disabled={busy}>Cancel</button>
								</div>
								<button type="button" class="btn-danger remove-btn" onclick={() => remove(ghost)} disabled={busy}>
									Remove from project
								</button>
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		</div>
	</div>
{/if}

<style>
	.member-groups {
		margin: 0 0 var(--space-3);
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

	.member-avatar {
		display: flex;
		flex: 0 0 auto;
		border-radius: 50%;
		box-shadow: 0 0 0 1px var(--color-border);
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

	.field input {
		width: 100%;
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
