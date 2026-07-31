<script lang="ts">
	// Picking is the whole interaction — there's no Save button because there's nothing to
	// type: a click is the edit. The chosen picture is applied optimistically so the large
	// preview moves the instant it's clicked, then the page reloads (the navbar avatar is
	// server-rendered from the JWT, not an island, so nothing else would catch up).
	import Avatar from './Avatar.svelte';
	import { AVATAR_IDS, avatarSrc, type AvatarId } from '../lib/avatars';

	let {
		initialAvatar,
		displayName,
	}: { initialAvatar: string | null; displayName: string } = $props();

	let selected = $state<string | null>(initialAvatar);
	let saving = $state(false);
	let error = $state<string | null>(null);

	async function choose(avatar: AvatarId | null) {
		if (saving || avatar === selected) return;

		const previous = selected;
		selected = avatar;
		saving = true;
		error = null;

		const formData = new FormData();
		formData.set('avatar', avatar ?? '');

		const res = await fetch('/api/account/update-avatar', { method: 'POST', body: formData });

		if (!res.ok) {
			error = await res.text();
			selected = previous;
			saving = false;
			return;
		}

		location.reload();
	}
</script>

<div class="avatar-picker">
	<div class="current">
		<Avatar avatar={selected} {displayName} size={72} />
		<p class="muted current-note">
			{selected ? 'Shown next to your name and in the navbar.' : 'No picture yet — your initial is shown instead.'}
		</p>
	</div>

	<div class="choices">
		{#each AVATAR_IDS as id}
			<button
				type="button"
				class="choice"
				class:selected={selected === id}
				disabled={saving}
				aria-pressed={selected === id}
				aria-label={`Use the ${id} picture`}
				onclick={() => choose(id)}
			>
				<img src={avatarSrc(id)} alt="" width="48" height="48" />
			</button>
		{/each}

		<button
			type="button"
			class="choice choice-none"
			class:selected={selected === null}
			disabled={saving}
			aria-pressed={selected === null}
			aria-label="Use no picture"
			onclick={() => choose(null)}
		>
			None
		</button>
	</div>

	{#if error}<p class="form-note error">{error}</p>{/if}
</div>

<style>
	.avatar-picker {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.current {
		display: flex;
		align-items: center;
		gap: var(--space-4);
	}

	.current-note {
		margin: 0;
		font-size: 0.85rem;
	}

	.choices {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
	}

	/* The selection ring is a box-shadow rather than a border so picking one doesn't
	   resize the row — same reason the navbar trigger uses one. */
	.choice {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 48px;
		height: 48px;
		padding: 0;
		background: none;
		border: none;
		border-radius: 50%;
		box-shadow: 0 0 0 1px var(--color-border);
		cursor: pointer;
		line-height: 0;
	}

	.choice img {
		display: block;
		width: 100%;
		height: 100%;
		border-radius: 50%;
	}

	.choice:hover:not(:disabled) {
		box-shadow: 0 0 0 2px var(--color-border-strong);
	}

	.choice.selected {
		box-shadow: 0 0 0 3px var(--color-border-strong);
	}

	.choice:disabled {
		cursor: default;
		opacity: 0.6;
	}

	.choice-none {
		font-family: inherit;
		font-size: 0.75rem;
		line-height: 1;
		color: var(--color-muted);
		background: var(--color-highlight);
	}
</style>
