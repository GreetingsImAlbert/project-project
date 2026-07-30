<script lang="ts">
	import { onMount } from 'svelte';

	interface SidebarProject {
		id: string;
		name: string;
		ownerName: string;
	}

	let {
		projects,
		currentPath,
		displayName,
	}: {
		projects: SidebarProject[];
		currentPath: string;
		displayName: string;
	} = $props();

	const STORAGE_KEY_COLLAPSED = 'p2-sidebar-collapsed';
	const STORAGE_KEY_WIDTH = 'p2-sidebar-width';
	const DEFAULT_WIDTH = 240;
	const MIN_WIDTH = 160;
	const MAX_WIDTH = 400;

	let collapsed = $state(false);
	let width = $state(DEFAULT_WIDTH);
	let dragging = $state(false);

	let currentProjectId = $derived.by(() => {
		const match = currentPath.match(/^\/projects\/([^/]+)/);
		return match ? match[1] : null;
	});

	onMount(() => {
		const storedCollapsed = localStorage.getItem(STORAGE_KEY_COLLAPSED);
		if (storedCollapsed === 'true') collapsed = true;
		const storedWidth = localStorage.getItem(STORAGE_KEY_WIDTH);
		if (storedWidth) {
			const w = parseInt(storedWidth, 10);
			if (w >= MIN_WIDTH && w <= MAX_WIDTH) width = w;
		}
	});

	function toggle() {
		collapsed = !collapsed;
		localStorage.setItem(STORAGE_KEY_COLLAPSED, String(collapsed));
	}

	function onPointerDown(e: PointerEvent) {
		e.preventDefault();
		dragging = true;
		const el = e.currentTarget as HTMLElement;
		el.setPointerCapture(e.pointerId);
	}

	function onPointerMove(e: PointerEvent) {
		if (!dragging) return;
		const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, e.clientX));
		width = newWidth;
	}

	function onPointerUp() {
		if (!dragging) return;
		dragging = false;
		localStorage.setItem(STORAGE_KEY_WIDTH, String(width));
	}
</script>

<aside
	class="app-sidebar"
	class:collapsed
	style={collapsed ? undefined : `width:${width}px`}
>
	<div class="sidebar-content">
		<button type="button" class="sidebar-toggle" onclick={toggle} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
			{collapsed ? '▶' : '◀'}
		</button>

		{#if !collapsed}
			<p class="sidebar-welcome">Welcome, {displayName}</p>

			<nav class="sidebar-nav">
				<a href="/" class:active={currentPath === '/'}>Dashboard</a>
				<a href="/projects" class:active={currentPath === '/projects'}>Projects</a>

				<ul class="project-list">
					{#each projects as project}
						<li>
							<a
								href={`/projects/${project.id}`}
								class="project-link"
								class:active={currentProjectId === project.id}
							>
								{project.ownerName}/{project.name}
							</a>
						</li>
					{/each}
					<li>
						<a href="/projects/new" class="add-project">+ Add project</a>
					</li>
				</ul>
			</nav>
		{/if}
	</div>

	{#if !collapsed}
		<div
			class="resize-handle"
			class:active={dragging}
			role="separator"
			aria-orientation="vertical"
			onpointerdown={onPointerDown}
			onpointermove={onPointerMove}
			onpointerup={onPointerUp}
		></div>
	{/if}
</aside>

<style>
	.app-sidebar {
		position: relative;
		flex-shrink: 0;
		display: flex;
		border-right: 1px solid var(--color-border);
		min-height: 0;
	}

	.app-sidebar.collapsed {
		width: auto;
	}

	.sidebar-content {
		flex: 1;
		min-width: 0;
		overflow-y: auto;
		overflow-x: hidden;
		padding: var(--space-4) var(--space-4) var(--space-7);
	}

	.collapsed .sidebar-content {
		padding: var(--space-4) var(--space-2);
	}

	.sidebar-toggle {
		background: none;
		border: none;
		padding: 0;
		color: var(--color-muted);
		font-size: 0.7rem;
		cursor: pointer;
		margin-bottom: var(--space-3);
	}

	.sidebar-toggle:hover {
		color: var(--color-fg);
	}

	.sidebar-welcome {
		font-size: 0.82rem;
		margin: 0 0 var(--space-5);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.sidebar-nav {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		font-size: 0.85rem;
	}

	.sidebar-nav > a {
		font-weight: 700;
		border-bottom: none;
	}

	.sidebar-nav > a:hover {
		border-bottom: none;
		color: var(--color-muted);
	}

	.sidebar-nav > a.active {
		text-decoration: underline;
		text-underline-offset: 3px;
	}

	.project-list {
		list-style: none;
		margin: var(--space-1) 0 0;
		padding: 0 0 0 var(--space-4);
	}

	.project-list li {
		margin-bottom: var(--space-1);
	}

	.project-link {
		font-size: 0.82rem;
		display: block;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		border-bottom: none;
	}

	.project-link:hover {
		border-bottom: none;
		color: var(--color-muted);
	}

	.project-link.active {
		font-weight: 700;
	}

	.add-project {
		font-size: 0.82rem;
		color: var(--color-muted);
		border-bottom: none;
	}

	.add-project:hover {
		color: var(--color-fg);
		border-bottom: none;
	}

	.resize-handle {
		position: absolute;
		top: 0;
		right: -3px;
		width: 6px;
		height: 100%;
		cursor: col-resize;
		z-index: 10;
	}

	.resize-handle:hover,
	.resize-handle.active {
		background: var(--color-border-strong);
		opacity: 0.3;
	}

	@media (max-width: 768px) {
		.app-sidebar {
			display: none;
		}
	}
</style>
