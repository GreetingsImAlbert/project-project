<script lang="ts">
	// Circular profile picture. Falls back to the first letter of the display name when
	// nobody has picked one, so the shape on the page is the same either way.
	import { avatarSrc, normalizeAvatar } from '../lib/avatars';

	let {
		avatar,
		displayName = '',
		size = 32,
	}: {
		avatar: string | null | undefined;
		displayName?: string;
		size?: number;
	} = $props();

	const picked = $derived(normalizeAvatar(avatar));
	const initial = $derived(displayName.trim().charAt(0).toUpperCase() || '?');
</script>

<span class="avatar" style={`--avatar-size: ${size}px`} aria-hidden="true">
	{#if picked}
		<img src={avatarSrc(picked)} alt="" width={size} height={size} />
	{:else}
		<span class="avatar-initial">{initial}</span>
	{/if}
</span>

<style>
	.avatar {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: var(--avatar-size);
		height: var(--avatar-size);
		border-radius: 50%;
		overflow: hidden;
		background: var(--color-highlight-strong);
	}

	.avatar img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.avatar-initial {
		font-size: calc(var(--avatar-size) * 0.45);
		font-weight: 700;
		line-height: 1;
		color: var(--color-fg);
	}
</style>
