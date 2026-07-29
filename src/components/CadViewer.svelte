<script lang="ts">
	// Interactive mesh preview for the file viewer panel. Loaded only through a dynamic
	// import from FileViewerPanel, which is what keeps three.js — several hundred KB — in
	// its own chunk and out of every page that merely lists files.
	//
	// View-only by design: orbit, zoom, pan. STL/OBJ/PLY/3MF are triangle soups the loaders
	// below hand back directly; STEP/IGES are boundary representations instead and go
	// through occt-import-js (OpenCASCADE compiled to WASM) in cad-worker.ts, off the main
	// thread — see loadBrepModel.
	import { onMount } from 'svelte';
	import * as THREE from 'three';
	import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
	import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
	import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
	import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
	import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
	import { onSwapOrDestroy } from '../lib/island-teardown';
	import { splitFilename } from '../lib/file-kind';
	import type { CadWorkerMesh, CadWorkerRequest, CadWorkerResponse } from '../lib/cad-worker';
	// Resolved to an absolute URL below, on the main thread — see the comment on
	// CadWorkerRequest.wasmUrl for why that resolution doesn't happen inside the worker.
	import wasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';

	let { fileId, filename }: { fileId: string; filename: string } = $props();

	let containerEl = $state<HTMLDivElement | null>(null);
	// Reactive on purpose, unlike the WebGL objects below: the load effect has to wait for
	// the scene to exist, and Svelte makes no promise about whether onMount or a user
	// effect runs first.
	let ready = $state(false);
	let loading = $state(true);
	let error = $state<string | null>(null);
	// 0–1 while the bytes come down, or null when the response had no content-length to
	// measure against. A 40 MB assembly takes long enough that a bare spinner reads as a
	// hang.
	let progress = $state<number | null>(null);
	let triangles = $state(0);
	let dims = $state<{ x: number; y: number; z: number } | null>(null);
	let wireframe = $state(false);

	// Everything below is plain (non-reactive) state: it's imperative WebGL bookkeeping,
	// and making Three's own mutable objects reactive only invites proxy overhead and
	// effects that re-run on every camera nudge.
	let renderer: THREE.WebGLRenderer | null = null;
	let scene: THREE.Scene | null = null;
	let camera: THREE.PerspectiveCamera | null = null;
	let controls: OrbitControls | null = null;
	// The loaded model and its floor grid, held so they can be disposed when the panel is
	// pointed at a different file.
	let model: THREE.Object3D | null = null;
	let grid: THREE.GridHelper | null = null;

	// Where framing put the camera, so Reset view can go back there without re-measuring.
	const homePosition = new THREE.Vector3();
	const homeTarget = new THREE.Vector3();

	let frameHandle = 0;
	// Bumped per load, for the same reason FileViewerPanel bumps its own: a 30 MB download
	// that lands after the user has clicked another file must not paint itself into the
	// canvas.
	let loadSeq = 0;
	let inflight: AbortController | null = null;
	// The tessellation worker for a STEP/IGES load in flight, if any — terminating it is how
	// a load in progress gets cancelled, since occt-import-js has no cooperative abort of its
	// own once a file is handed to it.
	let inflightWorker: Worker | null = null;

	// STEP/IGES can carry real per-solid colour, same reason 3MF keeps its own materials
	// instead of the neutral grey below.
	const BREP_EXTENSIONS = new Set(['step', 'stp', 'iges', 'igs']);

	// Neutral machined-part grey, deliberately fixed rather than themed: the model is the
	// subject, and recolouring it per theme would make the same part look like a different
	// material. Only the grid follows the theme, since it's chrome.
	const PART_COLOR = 0xb4bcc4;

	// Nothing renders on a timer — a viewer that spins the GPU while sitting idle in a
	// side panel is a laptop battery for no reason. Every path that changes what's on
	// screen asks for exactly one frame.
	function scheduleRender() {
		if (frameHandle || !renderer) return;
		frameHandle = requestAnimationFrame(() => {
			frameHandle = 0;
			if (renderer && scene && camera) renderer.render(scene, camera);
		});
	}

	function cssColor(name: string, fallback: number): number {
		if (!containerEl) return fallback;
		const raw = getComputedStyle(containerEl).getPropertyValue(name).trim();
		if (!raw) return fallback;
		try {
			return new THREE.Color(raw).getHex();
		} catch {
			return fallback;
		}
	}

	function resize() {
		if (!containerEl || !renderer || !camera) return;

		const { clientWidth: w, clientHeight: h } = containerEl;
		// The panel starts at zero height for a tick while it lays out, and a zero aspect
		// ratio poisons the projection matrix with NaNs.
		if (w === 0 || h === 0) return;

		renderer.setSize(w, h, false);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		scheduleRender();
	}

	// Frees the GPU-side buffers a dropped model leaves behind. Three keeps geometries and
	// materials alive until told otherwise, so without this every file opened in the panel
	// leaks its own vertex buffers for as long as the tab lives.
	function disposeObject(obj: THREE.Object3D) {
		obj.traverse((node) => {
			const mesh = node as THREE.Mesh;
			mesh.geometry?.dispose?.();
			const material = mesh.material;
			if (Array.isArray(material)) {
				for (const m of material) m.dispose();
			} else {
				material?.dispose?.();
			}
		});
	}

	function clearGrid() {
		if (!grid) return;
		scene?.remove(grid);
		grid.geometry.dispose();
		const material = grid.material as THREE.Material | THREE.Material[];
		if (Array.isArray(material)) {
			for (const m of material) m.dispose();
		} else {
			material.dispose();
		}
		grid = null;
	}

	function clearModel() {
		if (model && scene) {
			scene.remove(model);
			disposeObject(model);
		}
		clearGrid();
		model = null;
		triangles = 0;
		dims = null;
	}

	// GridHelper bakes its two colours into a vertex-colour attribute, so a theme change
	// can't be applied to the existing material — the helper has to be rebuilt. The
	// measurements are kept so the rebuild doesn't need the model's bounding box again.
	let gridSpan = 0;
	let gridY = 0;

	function buildGrid() {
		if (!scene || gridSpan <= 0) return;

		clearGrid();
		grid = new THREE.GridHelper(
			gridSpan,
			20,
			cssColor('--color-border-strong', 0x888888),
			cssColor('--color-border', 0xcccccc)
		);
		grid.position.y = gridY;
		const material = grid.material as THREE.Material;
		material.transparent = true;
		material.opacity = 0.5;
		scene.add(grid);
	}

	function partMaterial(): THREE.MeshStandardMaterial {
		return new THREE.MeshStandardMaterial({
			color: PART_COLOR,
			roughness: 0.55,
			metalness: 0.05,
			// Meshes exported from CAD are frequently not watertight, and a flipped or
			// missing facet would otherwise show as a hole straight through the part.
			side: THREE.DoubleSide,
		});
	}

	// Streamed rather than awaited whole so the progress line can move. The bytes still end
	// up in one buffer at the end — every loader here parses from a complete file.
	async function fetchModel(id: string, signal: AbortSignal): Promise<ArrayBuffer> {
		const res = await fetch(`/api/files/${id}/raw`, { signal });

		if (!res.ok) {
			throw new Error((await res.text()) || 'Could not load this model');
		}

		const total = Number(res.headers.get('content-length'));
		if (!res.body || !Number.isFinite(total) || total <= 0) return res.arrayBuffer();

		const reader = res.body.getReader();
		const chunks: Uint8Array[] = [];
		let received = 0;

		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			received += value.length;
			progress = Math.min(received / total, 1);
		}

		const bytes = new Uint8Array(received);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.length;
		}
		return bytes.buffer;
	}

	async function buildModel(extension: string, buffer: ArrayBuffer): Promise<THREE.Object3D> {
		switch (extension) {
			case 'stl':
				// Handles both the binary and the ASCII flavour off the same buffer.
				return new THREE.Mesh(new STLLoader().parse(buffer), partMaterial());
			case 'ply':
				return new THREE.Mesh(new PLYLoader().parse(buffer), partMaterial());
			case 'obj':
				// The only text format here, and the only one that can reference a .mtl we
				// have no way to fetch — so its materials are replaced wholesale below.
				return new OBJLoader().parse(new TextDecoder().decode(buffer));
			case '3mf':
				return new ThreeMFLoader().parse(buffer);
			case 'step':
			case 'stp':
				return loadBrepModel('step', buffer);
			case 'iges':
			case 'igs':
				return loadBrepModel('iges', buffer);
			default:
				throw new Error('Unsupported model format');
		}
	}

	// Hands the raw bytes to cad-worker.ts and turns its per-solid mesh list back into a
	// THREE.Object3D, the same shape every other branch of buildModel returns. A fresh
	// worker per call rather than a shared one kept around: it makes cancelling a load (the
	// user opens another file, or closes the panel) as simple as terminate(), with no
	// message-id bookkeeping to match a stale response back to an abandoned request.
	function loadBrepModel(format: CadWorkerRequest['format'], buffer: ArrayBuffer): Promise<THREE.Object3D> {
		return new Promise((resolve, reject) => {
			const worker = new Worker(new URL('../lib/cad-worker.ts', import.meta.url), { type: 'module' });
			inflightWorker = worker;

			function settle() {
				worker.terminate();
				if (inflightWorker === worker) inflightWorker = null;
			}

			worker.onmessage = (ev: MessageEvent<CadWorkerResponse>) => {
				settle();
				const data = ev.data;
				if (!data.success) {
					reject(new Error(data.error));
					return;
				}
				resolve(meshesToObject(data.meshes));
			};

			worker.onerror = (ev) => {
				settle();
				// ev.message is the underlying exception's real text (emscripten aborts are
				// often specific — "abort(OOM)", a missing-export message, etc.) — worth
				// surfacing over a generic string when the worker fails outside the
				// try/catch in cad-worker.ts (e.g. an error thrown asynchronously, off the
				// promise chain that catch actually covers).
				reject(new Error(ev.message || 'Could not read this model'));
			};

			const wasmAbsoluteUrl = new URL(wasmUrl, window.location.href).href;
			worker.postMessage({ format, buffer, wasmUrl: wasmAbsoluteUrl } satisfies CadWorkerRequest, [buffer]);
		});
	}

	// Colour, when occt-import-js found one on the solid; the same neutral material as the
	// other formats otherwise. Most mechanical STEP/IGES exports carry no colour at all.
	function meshesToObject(meshes: CadWorkerMesh[]): THREE.Object3D {
		const group = new THREE.Group();
		for (const mesh of meshes) {
			const geometry = new THREE.BufferGeometry();
			geometry.setAttribute('position', new THREE.BufferAttribute(mesh.position, 3));
			if (mesh.normal) geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normal, 3));
			geometry.setIndex(new THREE.BufferAttribute(mesh.index, 1));

			const material = mesh.color
				? new THREE.MeshStandardMaterial({
						color: new THREE.Color(mesh.color[0], mesh.color[1], mesh.color[2]),
						roughness: 0.55,
						metalness: 0.05,
						side: THREE.DoubleSide,
					})
				: partMaterial();

			group.add(new THREE.Mesh(geometry, material));
		}
		return group;
	}

	// Counts triangles, gives every mesh usable normals and (for the group formats) a
	// consistent material. 3MF is the one exception: it carries real per-object colour, so
	// what it came with is kept.
	function prepare(obj: THREE.Object3D, keepMaterials: boolean) {
		let count = 0;

		obj.traverse((node) => {
			if (!(node as THREE.Mesh).isMesh) return;
			const mesh = node as THREE.Mesh;

			// A flat-shaded STL has no normals of its own, and neither does a point-cloud-ish
			// PLY; without them the part renders as a silhouette.
			if (!mesh.geometry.getAttribute('normal')) mesh.geometry.computeVertexNormals();

			if (!keepMaterials) {
				const old = mesh.material;
				mesh.material = partMaterial();
				if (Array.isArray(old)) {
					for (const m of old) m.dispose();
				} else {
					old?.dispose?.();
				}
			}

			const index = mesh.geometry.getIndex();
			const position = mesh.geometry.getAttribute('position');
			count += Math.floor((index ? index.count : (position?.count ?? 0)) / 3);
		});

		triangles = count;
	}

	// Centres the model on the origin, pulls the camera back far enough to hold all of it,
	// and lays a grid under it at the size of the part rather than a fixed one.
	function frameModel(obj: THREE.Object3D) {
		if (!scene || !camera || !controls) return;

		const box = new THREE.Box3().setFromObject(obj);
		if (box.isEmpty()) throw new Error('This model has no geometry to show');

		const size = box.getSize(new THREE.Vector3());
		const center = box.getCenter(new THREE.Vector3());
		dims = { x: size.x, y: size.y, z: size.z };

		// Orbiting around the model's own centre, not wherever its author put the origin —
		// a part modelled far off-origin would otherwise swing around the screen.
		obj.position.sub(center);

		const radius = Math.max(size.length() / 2, 1e-6);
		const distance = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.25;

		// Scaled to the part: a 5 mm bracket and a 2 m frame both have to sit inside the
		// depth buffer without z-fighting.
		camera.near = radius / 100;
		camera.far = radius * 100;
		camera.position.copy(new THREE.Vector3(1, 0.65, 1).normalize().multiplyScalar(distance));
		camera.updateProjectionMatrix();

		controls.target.set(0, 0, 0);
		controls.minDistance = radius * 0.05;
		controls.maxDistance = radius * 20;
		controls.update();

		homePosition.copy(camera.position);
		homeTarget.copy(controls.target);

		// A grid twice the part's footprint, sitting on its underside.
		gridSpan = Math.max(size.x, size.z, radius) * 2;
		gridY = -size.y / 2;
		buildGrid();
	}

	async function load(id: string) {
		const seq = ++loadSeq;

		inflight?.abort();
		inflight = new AbortController();
		inflightWorker?.terminate();
		inflightWorker = null;

		clearModel();
		loading = true;
		error = null;
		progress = null;
		scheduleRender();

		const extension = splitFilename(filename.toLowerCase()).ext.slice(1);

		try {
			const buffer = await fetchModel(id, inflight.signal);
			if (seq !== loadSeq) return;

			const obj = await buildModel(extension, buffer);
			prepare(obj, extension === '3mf' || BREP_EXTENSIONS.has(extension));
			frameModel(obj);

			// Re-checked after parsing too: tessellating a large mesh is slow enough that the
			// user can easily have moved on between the fetch and here.
			if (seq !== loadSeq) {
				disposeObject(obj);
				return;
			}

			model = obj;
			scene?.add(obj);
			applyWireframe();
			loading = false;
			resize();
			scheduleRender();
		} catch (e) {
			if (seq !== loadSeq) return;
			// An abort is this component replacing its own load, not a failure to report.
			if (e instanceof DOMException && e.name === 'AbortError') return;
			error = e instanceof Error ? e.message : 'Could not load this model';
			loading = false;
		}
	}

	function applyWireframe() {
		if (!model) return;
		model.traverse((node) => {
			const mesh = node as THREE.Mesh;
			if (!mesh.isMesh) return;
			const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
			for (const m of materials) {
				(m as THREE.MeshStandardMaterial).wireframe = wireframe;
			}
		});
		scheduleRender();
	}

	function resetView() {
		if (!camera || !controls) return;
		camera.position.copy(homePosition);
		controls.target.copy(homeTarget);
		controls.update();
		scheduleRender();
	}

	// Millimetres is what CAD tools export STL/OBJ/PLY in by default and what 3MF is
	// normalised to, but none of the first three actually records a unit — hence the note
	// on the readout rather than a bare "mm".
	function formatDim(value: number): string {
		if (value >= 100) return value.toFixed(0);
		if (value >= 10) return value.toFixed(1);
		return value.toFixed(2);
	}

	onMount(() => {
		if (!containerEl) return;

		try {
			renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
		} catch {
			error = 'This browser cannot show 3D previews (WebGL unavailable)';
			loading = false;
			return;
		}

		// Capped at 2: a 3x-DPR phone renders nine times the pixels for no visible gain on
		// a shaded grey part, and drops frames doing it.
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		// alpha + no clear colour, so the panel's own background shows through and the
		// viewer follows the theme without being told about it.
		renderer.setClearColor(0x000000, 0);
		containerEl.appendChild(renderer.domElement);

		scene = new THREE.Scene();
		camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);

		// The key light is parented to the camera, so the face being looked at is always the
		// lit one — a fixed light leaves the far side of a part in the dark and makes the
		// model look broken when it's merely turned around.
		const key = new THREE.DirectionalLight(0xffffff, 2.2);
		key.position.set(0.6, 1, 0.8);
		camera.add(key);
		const fill = new THREE.DirectionalLight(0xffffff, 0.7);
		fill.position.set(-1, -0.4, -0.6);
		camera.add(fill);
		scene.add(camera);
		scene.add(new THREE.HemisphereLight(0xffffff, 0x333340, 1.4));

		controls = new OrbitControls(camera, renderer.domElement);
		// No damping, deliberately: damping needs a continuous animation loop to settle,
		// which is exactly the idle GPU spin scheduleRender() exists to avoid.
		controls.enableDamping = false;
		controls.addEventListener('change', scheduleRender);

		// The panel is drag-resizable, so the canvas can't be sized once at mount.
		const observer = new ResizeObserver(resize);
		observer.observe(containerEl);

		// The grid is the one part of the scene painted in theme colours, so it has to be
		// rebuilt when the theme changes under it.
		const themeWatcher = new MutationObserver(() => {
			if (!grid) return;
			buildGrid();
			scheduleRender();
		});
		themeWatcher.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['data-theme'],
		});

		resize();
		ready = true;

		// Astro's ClientRouter throws an island's DOM away without destroying the component,
		// so a WebGL context freed only in onDestroy would never be freed at all. Browsers
		// allow roughly 16 live contexts and drop the oldest — leaking one per navigation
		// kills the viewer after a dozen page moves. See lib/island-teardown.ts.
		return onSwapOrDestroy(() => {
			inflight?.abort();
			inflightWorker?.terminate();
			// Stops a queued frame from rendering into a context that's about to go.
			if (frameHandle) cancelAnimationFrame(frameHandle);
			frameHandle = 0;
			observer.disconnect();
			themeWatcher.disconnect();
			controls?.dispose();
			clearModel();
			renderer?.dispose();
			// dispose() releases Three's own resources but leaves the context itself alive
			// until GC gets round to it, which is far too late when contexts are the scarce
			// thing being counted.
			renderer?.forceContextLoss();
			renderer?.domElement.remove();
			renderer = null;
			scene = null;
			camera = null;
			controls = null;
		});
	});

	// Not folded into onMount: the panel keeps one CadViewer alive and re-points it at
	// another file, so the load has to be able to run again without a remount.
	$effect(() => {
		const id = fileId;
		if (!ready) return;
		load(id);
	});

	$effect(() => {
		// Reading `wireframe` here is what subscribes this effect to the toggle.
		wireframe;
		applyWireframe();
	});
</script>

<div class="cad">
	<div class="stage" bind:this={containerEl} aria-label={`3D preview of ${filename}`} role="img"></div>

	{#if loading}
		<p class="overlay muted">
			{#if progress !== null}
				Loading… {Math.round(progress * 100)}%
			{:else}
				Loading…
			{/if}
		</p>
	{:else if error}
		<p class="overlay error">{error}</p>
	{/if}

	{#if !loading && !error}
		<div class="cad-bar">
			<span class="readout" title="STL, OBJ and PLY carry no unit of their own; millimetres is what CAD tools export by default">
				{#if dims}
					{formatDim(dims.x)} × {formatDim(dims.y)} × {formatDim(dims.z)} mm<span class="muted">*</span>
				{/if}
			</span>
			<span class="readout muted">{triangles.toLocaleString()} triangles</span>
			<span class="spacer"></span>
			<button type="button" class="btn-plain" class:active={wireframe} onclick={() => (wireframe = !wireframe)}>
				Wireframe
			</button>
			<button type="button" class="btn-plain" onclick={resetView}>Reset view</button>
		</div>
	{/if}
</div>

<style>
	.cad {
		position: relative;
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}

	.stage {
		flex: 1;
		min-height: 0;
		/* The canvas is sized in JS from this element's box, so it must not be sized by the
		   canvas in turn — hence the explicit overflow and the block display below. */
		overflow: hidden;
		/* OrbitControls needs the pointer events for itself; without this a drag inside the
		   canvas scrolls the panel on touch instead of rotating the part. */
		touch-action: none;
		cursor: grab;
	}

	.stage:active {
		cursor: grabbing;
	}

	.stage :global(canvas) {
		display: block;
		width: 100%;
		height: 100%;
	}

	.overlay {
		position: absolute;
		top: 50%;
		left: 0;
		right: 0;
		transform: translateY(-50%);
		margin: 0;
		padding: 0 var(--space-3);
		text-align: center;
		font-size: 0.85rem;
	}

	.overlay.error {
		color: var(--color-danger);
	}

	.cad-bar {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		flex: 0 0 auto;
		padding-top: var(--space-2);
		border-top: 1px solid var(--color-border);
		font-size: 0.75rem;
	}

	.readout {
		white-space: nowrap;
	}

	.spacer {
		flex: 1 1 auto;
	}

	.cad-bar button {
		font-size: 0.75rem;
		padding: var(--space-1) var(--space-2);
	}

	.cad-bar button.active {
		background: var(--color-fg);
		color: var(--color-bg);
	}

	/* On a narrow panel the readout and the two buttons can't share a line. */
	@media (max-width: 480px) {
		.cad-bar {
			flex-wrap: wrap;
			gap: var(--space-2);
		}
	}
</style>
