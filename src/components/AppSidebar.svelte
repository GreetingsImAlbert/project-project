<script lang="ts">
	import { onMount } from 'svelte';
	import Avatar from './Avatar.svelte';

	interface SidebarProject {
		id: string;
		name: string;
		owner: { displayName: string; avatar: string | null };
		// The reader's own open tasks in that project.
		taskCount: number;
	}

	let {
		projects: initialProjects = [],
		currentPath: initialCurrentPath,
		displayName,
		avatar,
	}: {
		projects?: SidebarProject[];
		currentPath: string;
		displayName: string;
		avatar: string | null;
	} = $props();

	let projects = $state(initialProjects);
	let currentPath = $state(initialCurrentPath);

	let navigationRequest: Promise<SidebarProject[]> | null = null;

	async function loadProjects(): Promise<SidebarProject[]> {
		if (!navigationRequest) {
			navigationRequest = fetch('/api/navigation')
				.then(async (response) => {
					if (!response.ok) throw new Error('Could not load navigation');
					const result = (await response.json()) as { projects: SidebarProject[] };
					return result.projects;
				})
				.catch((error) => {
					navigationRequest = null;
					throw error;
				});
		}

		return navigationRequest;
	}

	onMount(() => {
		void loadProjects()
			.then((loadedProjects) => {
				projects = loadedProjects;
			})
			.catch(() => {
				// The primary navigation links still work when the optional project list is unavailable.
			});

		function updateCurrentPath() {
			currentPath = window.location.pathname;
		}

		document.addEventListener('astro:after-swap', updateCurrentPath);
		return () => document.removeEventListener('astro:after-swap', updateCurrentPath);
	});

	let currentProjectId = $derived.by(() => {
		const match = currentPath.match(/^\/projects\/([^/]+)/);
		return match ? match[1] : null;
	});

	// Pinned = stays open without the pointer, and the rail widens to the full panel so
	// the content reflows beside it instead of sitting under it. Persisted because the
	// component remounts on every page navigation (client:load + ClientRouter), and a
	// sidebar that silently re-folds on the next click would be worse than no pin at all.
	//
	// The attribute on <html>, not this state, is what the CSS below keys off: the inline
	// script in BaseLayout stamps it before first paint, whereas this component only
	// hydrates after it, so driving the width from a class here would paint the folded
	// rail for a frame on every navigation. The state is only the toggle's own copy of it.
	const PIN_KEY = 'p2-sidebar-pinned';
	const PIN_ATTR = 'data-sidebar-pinned';
	const NAV_ATTR = 'data-sidebar-navigating';
	let pinned = $state(
		typeof document !== 'undefined' && document.documentElement.hasAttribute(PIN_ATTR),
	);

	function setPinned(next: boolean) {
		pinned = next;
		document.documentElement.toggleAttribute(PIN_ATTR, next);
		try {
			localStorage.setItem(PIN_KEY, next ? '1' : '0');
		} catch {
			// Private mode / storage disabled: the pin just doesn't survive navigation.
		}
	}

	function keepExpandedForNavigation() {
		document.documentElement.setAttribute(NAV_ATTR, '');
	}

	function clearNavigationExpanded() {
		document.documentElement.removeAttribute(NAV_ATTR);
	}

	function togglePinnedFromButton(event: MouseEvent) {
		event.stopPropagation();
		setPinned(!pinned);
	}

	// The same click pins and unpins, and it's the same target either way — the panel
	// itself. Clicking out in the content deliberately does nothing: the sidebar is a
	// fixture, not a menu, so working in the page shouldn't put it away.
	// A click on a link is a navigation and leaves the pin alone.
	function onPanelClick(event: MouseEvent) {
		if (event.target instanceof Element && event.target.closest('a')) return;
		setPinned(!pinned);
	}
</script>

<!--
	Folded by default: the rail below is what actually takes space in the shell, and the
	panel inside it is absolutely positioned so expanding it overlays the content instead
	of shoving it sideways. `.hover-zone` is what makes the empty margin left of the shell
	count as "the sidebar area" — it reaches from the viewport's left edge to the rail's
	right edge, so a pointer drifting in from off-screen opens the sidebar before it ever
	touches a link. The panel outranks it in z-order, so once open every link is clickable.
-->
<div class="sidebar-rail" onpointerleave={clearNavigationExpanded}>
	<div class="hover-zone"></div>

	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<aside
		class="sidebar-panel"
		onclick={onPanelClick}
	>
		<div class="sidebar-content">
			<div class="sidebar-header-row">
				<button
					class="pin-toggle"
					class:pinned
					type="button"
					aria-label={pinned ? 'Unpin sidebar' : 'Pin sidebar'}
					aria-pressed={pinned}
					title={pinned ? 'Unpin sidebar' : 'Pin sidebar'}
					onclick={togglePinnedFromButton}
				>
					<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
						<path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5v6h2v-6h5v-2l-2-2Z" />
					</svg>
				</button>
			</div>
			<p class="sidebar-welcome row">
				<span class="row-icon">
					<Avatar {avatar} {displayName} size={26} />
				</span>
				<span class="row-label">Welcome, {displayName}</span>
			</p>

			<nav class="sidebar-nav">
				<a href="/" class="nav-link row" class:active={currentPath === '/'} title="Dashboard" data-astro-prefetch onpointerdown={keepExpandedForNavigation}>
					<span class="row-icon">
						<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<path d="M3 10.5 12 3l9 7.5" />
							<path d="M5 9.8V20h14V9.8" />
						</svg>
					</span>
					<span class="row-label">Dashboard</span>
				</a>
				<a href="/projects" class="nav-link row" class:active={currentPath === '/projects'} title="Projects" data-astro-prefetch onpointerdown={keepExpandedForNavigation}>
					<span class="row-icon">
						<span class="glyph-p">P</span>
					</span>
					<span class="row-label">Projects</span>
				</a>

				<ul class="project-list">
					{#each projects as project}
						<li>
							<a
								href={`/projects/${project.id}`}
								class="nav-link project-link row"
								class:active={currentProjectId === project.id}
								title={project.name}
								data-astro-prefetch
								onpointerdown={keepExpandedForNavigation}
							>
								<span class="row-icon" title={project.owner.displayName}>
									<Avatar avatar={project.owner.avatar} displayName={project.owner.displayName} size={22} />
								</span>
								<span class="row-label project-name">{project.name}</span>
								{#if project.taskCount > 0}
									<span class="row-label task-count" title={`${project.taskCount} of your tasks`}>
										{project.taskCount}
									</span>
								{/if}
							</a>
						</li>
					{/each}
					<li>
						<a href="/projects/new" class="nav-link add-project row" title="Add project" data-astro-prefetch onpointerdown={keepExpandedForNavigation}>
							<span class="row-icon">+</span>
							<span class="row-label">Add project</span>
						</a>
					</li>
				</ul>
			</nav>
		</div>
	</aside>
</div>

<style>
	.sidebar-rail {
		flex: 0 0 var(--rail-width);
		position: relative;
		min-height: 0;
		--rail-width: 56px;
		--panel-width: 280px;
		--icon-size: 26px;
		/* Centres the icon slot in the folded rail, which is also what makes the active
		   row's highlight sit square around it. */
		--row-inset: calc((var(--rail-width) - var(--icon-size)) / 2);
		transition: flex-basis 0.15s ease;
	}

	/* Reaches leftward out of the shell to the viewport edge — that empty margin is
	   dead space that belongs to the sidebar as far as the pointer is concerned. Kept
	   absolute (not fixed) so it stays the rail's own height and never covers the
	   header's logo. */
	.hover-zone {
		position: absolute;
		top: 0;
		bottom: 0;
		left: calc(-1 * max(0px, 50vw - (var(--max-width) / 2)));
		width: calc(var(--rail-width) + max(0px, 50vw - (var(--max-width) / 2)));
		z-index: 1;
	}

	.sidebar-panel {
		position: absolute;
		top: 0;
		bottom: 0;
		left: 0;
		width: var(--rail-width);
		display: flex;
		background: var(--color-surface-nav);
		border: none;
		box-shadow: 4px 0 8px -6px var(--color-border);
		overflow: hidden;
		z-index: 2;
		transition: width 0.15s ease;
	}

	/* Keep the shadow narrow and offset right so it reads as separation, not a floating panel. */
	.sidebar-rail:hover .sidebar-panel,
	.sidebar-rail:focus-within .sidebar-panel,
	:global(html[data-sidebar-navigating]) .sidebar-panel {
		width: var(--panel-width);
	}

	/* Pinned is in-flow, so it has content on one side and the page edge on the other —
	   retain the same subtle separation while it is expanded. */
	:global(html[data-sidebar-pinned]) .sidebar-panel {
		width: var(--panel-width);
	}

	.sidebar-content {
		flex: 1;
		width: var(--panel-width);
		overflow-y: auto;
		overflow-x: hidden;
		padding: var(--space-6) 0 var(--space-8);
	}

	.sidebar-header-row {
		display: flex;
		justify-content: flex-end;
		width: var(--panel-width);
		padding: 0 var(--space-4) var(--space-2);
		transform: translateY(calc(-1 * var(--space-4)));
	}

	.pin-toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-1);
		color: var(--color-muted);
		background: transparent;
		border: none;
		opacity: 0;
		pointer-events: none;
	}

	.pin-toggle.pinned {
		color: var(--color-fg);
	}

	.sidebar-rail:hover .pin-toggle,
	.sidebar-rail:focus-within .pin-toggle,
	:global(html[data-sidebar-pinned]) .pin-toggle,
	:global(html[data-sidebar-navigating]) .pin-toggle {
		opacity: 1;
		pointer-events: auto;
	}

	/* Every entry is an icon in a fixed-width slot plus a label: the slot is the only
	   thing that fits in the folded rail, so folding is just the labels fading out —
	   nothing moves. */
	.row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-2) var(--row-inset);
	}

	.row-icon {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		justify-content: center;
		width: var(--icon-size);
		height: var(--icon-size);
		color: var(--color-muted);
	}

	.row-label {
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		opacity: 0;
		transition: opacity 0.15s ease;
	}

	.sidebar-rail:hover .row-label,
	.sidebar-rail:focus-within .row-label,
	:global(html[data-sidebar-navigating]) .row-label,
	:global(html[data-sidebar-pinned]) .row-label {
		opacity: 1;
	}

	.glyph-p {
		font-weight: 700;
		font-size: 1.05rem;
		line-height: 1;
		color: var(--color-fg);
	}

	.sidebar-welcome {
		font-size: 0.82rem;
		margin: 0 0 var(--space-6);
	}

	.sidebar-nav {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		font-size: 0.85rem;
	}

	/* Location is carried by a background fill, not weight — bolding every top-level
	   entry made the whole nav read as selected. */
	.nav-link {
		border-bottom: none;
		border-radius: var(--radius-sm);
	}

	.nav-link:hover {
		background: var(--color-highlight);
		border-bottom: none;
	}

	.nav-link.active {
		background: var(--color-highlight-strong);
	}

	.nav-link:hover .row-icon,
	.nav-link.active .row-icon {
		color: var(--color-fg);
	}

	/* Indented only once open — folded, the owner pictures have to stay on the same
	   centre line as the icons above them or the rail reads as crooked. */
	.project-list {
		list-style: none;
		margin: var(--space-1) 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		transition: padding-left 0.15s ease;
	}

	.sidebar-rail:hover .project-list,
	.sidebar-rail:focus-within .project-list,
	:global(html[data-sidebar-navigating]) .project-list,
	:global(html[data-sidebar-pinned]) .project-list {
		padding-left: var(--space-4);
	}

	.project-link {
		font-size: 0.82rem;
	}

	.project-name {
		flex: 1;
	}

	.task-count {
		flex: 0 0 auto;
		font-size: 0.72rem;
		color: var(--color-muted);
		font-variant-numeric: tabular-nums;
	}

	.add-project {
		font-size: 0.82rem;
		color: var(--color-muted);
	}

	.add-project .row-icon {
		font-size: 1.1rem;
	}

	.add-project:hover {
		color: var(--color-fg);
	}

	@media (max-width: 768px) {
		.sidebar-rail {
			display: none;
		}
	}
</style>
