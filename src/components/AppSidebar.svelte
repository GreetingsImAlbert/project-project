<script lang="ts">
	import Avatar from './Avatar.svelte';

	interface SidebarProject {
		id: string;
		name: string;
		owner: { displayName: string; avatar: string | null };
		// The reader's own open tasks in that project.
		taskCount: number;
	}

	let {
		projects,
		currentPath,
		displayName,
		avatar,
	}: {
		projects: SidebarProject[];
		currentPath: string;
		displayName: string;
		avatar: string | null;
	} = $props();

	let currentProjectId = $derived.by(() => {
		const match = currentPath.match(/^\/projects\/([^/]+)/);
		return match ? match[1] : null;
	});
</script>

<!--
	Folded by default: the rail below is what actually takes space in the shell, and the
	panel inside it is absolutely positioned so expanding it overlays the content instead
	of shoving it sideways. `.hover-zone` is what makes the empty margin left of the shell
	count as "the sidebar area" — it reaches from the viewport's left edge to the rail's
	right edge, so a pointer drifting in from off-screen opens the sidebar before it ever
	touches a link. The panel outranks it in z-order, so once open every link is clickable.
-->
<div class="sidebar-rail">
	<div class="hover-zone"></div>

	<aside class="sidebar-panel">
		<div class="sidebar-content">
			<p class="sidebar-welcome row">
				<span class="row-icon">
					<Avatar {avatar} {displayName} size={26} />
				</span>
				<span class="row-label">Welcome, {displayName}</span>
			</p>

			<nav class="sidebar-nav">
				<a href="/" class="nav-link row" class:active={currentPath === '/'} title="Dashboard">
					<span class="row-icon">
						<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<path d="M3 10.5 12 3l9 7.5" />
							<path d="M5 9.8V20h14V9.8" />
						</svg>
					</span>
					<span class="row-label">Dashboard</span>
				</a>
				<a href="/projects" class="nav-link row" class:active={currentPath === '/projects'} title="Projects">
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
						<a href="/projects/new" class="nav-link add-project row" title="Add project">
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
		background: var(--color-surface-sidebar);
		border-right: 1px solid var(--color-border);
		overflow: hidden;
		z-index: 2;
		transition: width 0.15s ease;
	}

	.sidebar-rail:hover .sidebar-panel,
	.sidebar-panel:focus-within {
		width: var(--panel-width);
		box-shadow: var(--space-1) 0 var(--space-4) rgba(0, 0, 0, 0.12);
	}

	.sidebar-content {
		flex: 1;
		width: var(--panel-width);
		overflow-y: auto;
		overflow-x: hidden;
		padding: var(--space-6) var(--space-3) var(--space-8);
	}

	/* Every entry is an icon in a fixed-width slot plus a label: the slot is the only
	   thing that fits in the folded rail, so folding is just the labels fading out —
	   nothing moves. */
	.row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-2);
	}

	.row-icon {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
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
	.sidebar-panel:focus-within .row-label {
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

	.project-list {
		list-style: none;
		margin: var(--space-1) 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
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
