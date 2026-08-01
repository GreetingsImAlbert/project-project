<script lang="ts">
	// Picking is the whole interaction — there's no Save button because there's nothing to
	// type: a click is the edit. The chosen picture is applied optimistically so the large
	// preview moves the instant it's clicked, then the page reloads (the navbar avatar is
	// server-rendered from the JWT, not an island, so nothing else would catch up).
	import Avatar from './Avatar.svelte';
	import {
		AVATAR_IDS,
		CUSTOM_AVATAR_MAX_BYTES,
		CUSTOM_AVATAR_MAX_SOURCE_BYTES,
		CUSTOM_AVATAR_MIME_TYPES,
		avatarSrc,
		type AvatarId,
	} from '../lib/avatars';

	let {
		initialAvatar,
		displayName,
	}: { initialAvatar: string | null; displayName: string } = $props();

	let selected = $state<string | null>(initialAvatar);
	let saving = $state(false);
	let error = $state<string | null>(null);

	function blobToDataUrl(blob: Blob): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result));
			reader.onerror = () => reject(new Error('Could not read the compressed picture'));
			reader.readAsDataURL(blob);
		});
	}

	function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
		return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
	}

	async function compressImage(file: File): Promise<string> {
		if (!CUSTOM_AVATAR_MIME_TYPES.includes(file.type as (typeof CUSTOM_AVATAR_MIME_TYPES)[number])) {
			throw new Error('Choose a JPEG, PNG, or WebP picture');
		}
		if (file.size > CUSTOM_AVATAR_MAX_SOURCE_BYTES) {
			throw new Error('Choose a picture smaller than 10 MB');
		}

		const objectUrl = URL.createObjectURL(file);
		const image = new Image();
		image.decoding = 'async';
		image.src = objectUrl;
		try {
			await image.decode();
		} catch {
			URL.revokeObjectURL(objectUrl);
			throw new Error('That picture could not be read');
		}

		try {
			const sourceSize = Math.min(image.naturalWidth, image.naturalHeight);
			if (!sourceSize) throw new Error('That picture could not be read');

			for (const size of [256, 192, 128]) {
				const canvas = document.createElement('canvas');
				canvas.width = size;
				canvas.height = size;
				const context = canvas.getContext('2d');
				if (!context) throw new Error('Picture compression is unavailable in this browser');

				const scale = size / sourceSize;
				const sourceWidth = size / scale;
				const sourceHeight = size / scale;
				const sourceX = (image.naturalWidth - sourceWidth) / 2;
				const sourceY = (image.naturalHeight - sourceHeight) / 2;
				context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, size, size);

				for (const quality of [0.82, 0.72, 0.62, 0.52, 0.42]) {
					let blob = await canvasBlob(canvas, 'image/webp', quality);
					if (!blob || blob.type !== 'image/webp') blob = await canvasBlob(canvas, 'image/jpeg', quality);
					if (blob && blob.size <= CUSTOM_AVATAR_MAX_BYTES) return blobToDataUrl(blob);
				}
			}
		} finally {
			URL.revokeObjectURL(objectUrl);
		}

		throw new Error('That picture could not be compressed below 120 KB');
	}

	async function upload(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file || saving) return;

		const previous = selected;
		saving = true;
		error = null;
		try {
			const compressed = await compressImage(file);
			selected = compressed;
			const formData = new FormData();
			formData.set('avatar', compressed);
			const res = await fetch('/api/account/update-avatar', { method: 'POST', body: formData });
			if (!res.ok) throw new Error(await res.text());
			location.reload();
		} catch (uploadError) {
			selected = previous;
			error = uploadError instanceof Error ? uploadError.message : 'Could not update profile picture';
			saving = false;
		}
	}

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

		<label class="choice choice-upload" class:disabled={saving}>
			<span>Upload</span>
			<input type="file" accept="image/jpeg,image/png,image/webp" onchange={upload} disabled={saving} />
		</label>
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

	.choice-upload {
		font-family: inherit;
		font-size: 0.75rem;
		color: var(--color-muted);
		background: var(--color-highlight);
		cursor: pointer;
	}

	.choice-upload input {
		position: absolute;
		width: 1px;
		height: 1px;
		top: auto;
		left: -10000px;
	}

	.choice-upload.disabled {
		cursor: default;
		opacity: 0.6;
	}
</style>
