<script lang="ts">
	// Interactive mesh preview for the file viewer panel. Loaded only through a dynamic
	// import from FileViewerPanel, which is what keeps three.js — several hundred KB — in
	// its own chunk and out of every page that merely lists files.
	//
	// View-only by design: orbit, zoom, pan. STL/OBJ/PLY triangle soups and STEP/IGES
	// boundary representations are parsed off the main thread in cad-worker.ts (STEP/IGES
	// via occt-import-js, OpenCASCADE compiled to WASM; the rest via three's own loaders),
	// so a large file never freezes this tab while it parses — see loadModel. 3MF is the
	// exception, parsed here on the main thread — see build3mfObject.
	import { onMount } from 'svelte';
	import * as THREE from 'three';
	import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
	import { onSwapOrDestroy } from '../lib/island-teardown';
	import { splitFilename } from '../lib/file-kind';
	import { CATEGORY_COLOR_COUNT, CATEGORY_COLOR_SLOTS } from '../lib/category-color';
	// 3MF is parsed here rather than in cad-worker.ts — see build3mfObject.
	import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
	import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
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
	// 'default' = the site's theme ink color (--color-fg), always overriding any file
	// color. 'original' = whatever the file carried (falls back to --color-fg when
	// the format has no color). A number 0–9 = a category palette swatch. Persisted,
	// not per-file: it's a viewing preference.
	let colorSlot = $state<number | 'default' | 'original'>('default');

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
	// The parse worker for a load in flight, if any — terminating it is how a load in
	// progress gets cancelled, since none of the loaders in cad-worker.ts have a
	// cooperative abort of their own once a file is handed to them.
	let inflightWorker: Worker | null = null;

	// STEP/IGES can carry real per-solid colour, same reason 3MF (handled separately, see
	// build3mfObject) keeps its own per-object materials — both take priority over the
	// Default swatch's theme fallback in resolveColor.
	const BREP_EXTENSIONS = new Set(['step', 'stp', 'iges', 'igs']);

	// Fallback for cssColor() below, used only if the CSS variable it asks for somehow
	// resolves to nothing. Neutral machined-part grey — the same tone the picker's
	// Default swatch lands on before containerEl exists to read the real value from.
	const PART_COLOR_FALLBACK = 0xb4bcc4;

	const LOCAL_STORAGE_KEY = 'p2-cad-model-color';

	function colorVarFor(slot: number | 'default'): string {
		return slot === 'default' ? '--color-fg' : `--color-cat-${slot}-fg`;
	}

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

	// A swatch pick (colorSlot !== null) is a deliberate "paint the whole part this
	// colour" and wins over whatever the file carries. Left on Default, a solid keeps
	// its own colour when the format actually has one (STEP/IGES per-solid colour,
	// 3MF per-object materials) and only falls back to the theme's ink colour where
	// there's genuinely nothing to show (STL/OBJ/PLY, or a STEP/IGES solid with no
	// colour of its own).
	function resolveColor(fileColor: number | null): number {
		if (colorSlot === 'original') return fileColor ?? cssColor(colorVarFor('default'), PART_COLOR_FALLBACK);
		if (typeof colorSlot === 'number') return cssColor(colorVarFor(colorSlot), PART_COLOR_FALLBACK);
		return cssColor(colorVarFor('default'), PART_COLOR_FALLBACK);
	}

	// fileColor is stashed on the material so a later swatch pick or theme change (see
	// applyPartColor) can re-resolve it without re-parsing the mesh it came from.
	// vertexColors is 3MF-only: a part painted via a <colorgroup> carries its colour
	// on the geometry itself (a per-vertex 'color' attribute), not as a single hex —
	// enabling MeshStandardMaterial's own vertexColors lets that through unmodified,
	// with the base colour left neutral so it doesn't tint what the geometry already
	// carries. Only the 'original' slot honours per-vertex data; every other slot
	// overrides it with a uniform colour.
	function materialFor(fileColor: number | null, vertexColors = false): THREE.MeshStandardMaterial {
		const useVertexColors = vertexColors && colorSlot === 'original';
		const material = new THREE.MeshStandardMaterial({
			color: useVertexColors ? 0xffffff : resolveColor(fileColor),
			vertexColors: useVertexColors,
			roughness: 0.55,
			metalness: 0.05,
			side: THREE.DoubleSide,
		});
		material.userData.fileColor = fileColor;
		material.userData.vertexColors = vertexColors;
		return material;
	}

	function applyPartColor() {
		if (!model) return;
		model.traverse((node) => {
			const mesh = node as THREE.Mesh;
			if (!mesh.isMesh) return;
			const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
			for (const m of materials) {
				const material = m as THREE.MeshStandardMaterial;
				const fileColor = (material.userData?.fileColor ?? null) as number | null;
				const useVertexColors = Boolean(material.userData?.vertexColors) && colorSlot === 'original';
				if (material.vertexColors !== useVertexColors) {
					material.vertexColors = useVertexColors;
					material.needsUpdate = true;
				}
				material.color.setHex(useVertexColors ? 0xffffff : resolveColor(fileColor));
			}
		});
		scheduleRender();
	}

	function selectColor(slot: number | 'default' | 'original') {
		colorSlot = slot;
		try {
			if (slot === 'default') localStorage.removeItem(LOCAL_STORAGE_KEY);
			else localStorage.setItem(LOCAL_STORAGE_KEY, String(slot));
		} catch {}
		applyPartColor();
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

	const FORMAT_BY_EXTENSION: Record<string, CadWorkerRequest['format']> = {
		stl: 'stl',
		ply: 'ply',
		obj: 'obj',
		step: 'step',
		stp: 'step',
		iges: 'iges',
		igs: 'iges',
	};

	async function buildModel(extension: string, buffer: ArrayBuffer): Promise<THREE.Object3D> {
		// Not routed through cad-worker.ts like the rest: three's ThreeMFLoader parses the
		// model XML inside the .3mf zip via the global DOMParser, which dedicated workers
		// don't reliably expose the way Window does — off the main thread this throws
		// "DOMParser is not defined" in browsers that haven't added it there yet. The main
		// thread always has it, so 3MF is parsed here instead.
		if (extension === '3mf') return build3mfObject(buffer);

		const format = FORMAT_BY_EXTENSION[extension];
		if (!format) throw new Error('Unsupported model format');
		return loadModel(format, buffer);
	}

	// Mirrors meshesToObject below, but starting from the Group ThreeMFLoader hands back
	// rather than cad-worker.ts's flat mesh list — 3MF is the one format that carries
	// real per-object colour via a proper material instead of a bare [r, g, b]. Every
	// mesh gets re-parented onto a flat group (the same shape meshesToObject produces,
	// which frameModel/prepare expect), so each mesh's world transform — its own plus
	// whatever its 3MF parent nodes (components, build items) applied — has to be
	// baked into its own position/rotation/scale rather than just dropped; leaving
	// that out was why assemblies came out with bodies scattered in the wrong places.
	function build3mfObject(buffer: ArrayBuffer): THREE.Object3D {
		const source = new ThreeMFLoader().parse(buffer);
		source.updateMatrixWorld(true);
		const group = new THREE.Group();

		source.traverse((node) => {
			const mesh = node as THREE.Mesh;
			if (!mesh.isMesh) return;

			const sourceMaterial = (
				Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
			) as THREE.MeshPhongMaterial | undefined;
			// A MeshPhongMaterial's .color defaults to white, and ThreeMFLoader leaves it
			// at that default for three of its four mesh shapes — untextured/uncoloured
			// triangles, a texture map, or a per-vertex colour attribute — so reading
			// .color unconditionally was treating that default as if it were real file
			// colour and painting those parts white. Only a resolved <basematerials>
			// reference (name !== the loader's own DEFAULT_MATERIAL_NAME sentinel, no
			// map, no vertexColors) is an actual colour choice from the file.
			const hasVertexColors = Boolean(sourceMaterial?.vertexColors);
			const isPlaceholder = !sourceMaterial || sourceMaterial.name === THREE.Loader.DEFAULT_MATERIAL_NAME;
			const fileColor =
				!isPlaceholder && !hasVertexColors && !sourceMaterial.map ? sourceMaterial.color.getHex() : null;

			// ThreeMFLoader hands back an unindexed triangle soup with no normals of its
			// own — every vertex belongs to exactly one triangle, so computing normals
			// straight off that (as prepare() would for the other formats) gives each
			// triangle its own flat, unshared normal. On a curved surface that reads as
			// a grid of visible facet edges lined up exactly on the triangle edges,
			// i.e. the model looking seamed wherever wireframe mode would draw a line.
			// Welding the coincident vertices back into an indexed geometry first (kept
			// separate wherever another attribute — a UV seam, a per-vertex colour
			// boundary — genuinely differs) lets computeVertexNormals blend normals
			// across shared vertices instead, the same smooth shading a slicer preview
			// or the STEP/IGES tessellation already gives those formats.
			const geometry = mergeVertices(mesh.geometry);
			geometry.computeVertexNormals();

			const built = new THREE.Mesh(geometry, materialFor(fileColor, hasVertexColors));
			built.matrix.copy(mesh.matrixWorld).decompose(built.position, built.quaternion, built.scale);
			group.add(built);
		});

		return group;
	}

	// Hands the raw bytes to cad-worker.ts and turns its mesh list back into a
	// THREE.Object3D via meshesToObject. A fresh worker per call rather than a shared one
	// kept around: it makes cancelling a load (the user opens another file, or closes the
	// panel) as simple as terminate(), with no message-id bookkeeping to match a stale
	// response back to an abandoned request.
	function loadModel(format: CadWorkerRequest['format'], buffer: ArrayBuffer): Promise<THREE.Object3D> {
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

	// Colour, when cad-worker.ts found one on the solid (STEP/IGES); resolveColor's
	// theme fallback otherwise. Most mechanical STEP/IGES exports carry no colour at all.
	function meshesToObject(meshes: CadWorkerMesh[]): THREE.Object3D {
		const group = new THREE.Group();
		for (const mesh of meshes) {
			const geometry = new THREE.BufferGeometry();
			geometry.setAttribute('position', new THREE.BufferAttribute(mesh.position, 3));
			if (mesh.normal) geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normal, 3));
			// STL/OBJ/PLY commonly parse to non-indexed geometry; STEP/IGES always does.
			if (mesh.index) geometry.setIndex(new THREE.BufferAttribute(mesh.index, 1));

			// occt-import-js's triple is a plain display RGB fraction, the same space STEP
			// itself stores colour in — it has to be tagged SRGBColorSpace explicitly.
			// The bare `new THREE.Color(r, g, b)` constructor instead reads its arguments
			// as three.js's own working space (linear), so an unlabelled near-black like
			// (0.05, 0.05, 0.05) was being lightened noticeably (to ~0.35 sRGB) rather
			// than left alone — true (0,0,0)/(1,1,1) round-trip correctly either way,
			// which is why the effect only ever showed up on off-black/off-white parts.
			const fileColor = mesh.color
				? new THREE.Color().setRGB(mesh.color[0], mesh.color[1], mesh.color[2], THREE.SRGBColorSpace).getHex()
				: null;
			group.add(new THREE.Mesh(geometry, materialFor(fileColor)));
		}
		return group;
	}

	// Counts triangles, gives every mesh usable normals and (for the group formats) a
	// consistent material. STEP/IGES and 3MF are the exception: they carry real
	// per-solid colour, so what they came with is kept.
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
				mesh.material = materialFor(null);
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
			const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
			if (stored === 'original') {
				colorSlot = 'original';
			} else if (stored !== null) {
				const n = Number(stored);
				if (Number.isInteger(n) && n >= 0 && n < CATEGORY_COLOR_COUNT) colorSlot = n;
			}
		} catch {}

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

		// The grid and the picker's own materials are both painted in theme colours —
		// the grid because it's chrome, the picker because Default and every -fg swatch
		// are theme-dependent CSS variables — so both need rebuilding when the theme
		// changes under them.
		const themeWatcher = new MutationObserver(() => {
			if (grid) buildGrid();
			applyPartColor();
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
		}, '[data-global-file-viewer]');
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
	<!-- Default plus the ten task-category slots' -fg swatches. Default is styled from
	     --color-fg directly rather than a category slot, since it's the one option that
	     isn't "pick a colour" but "use the site's own ink colour for this theme". -->
	<div class="color-bar" role="group" aria-label="Model colour">
		<button
			type="button"
			class="swatch swatch-default"
			class:active={colorSlot === 'default'}
			aria-label="Default colour"
			title="Default (follows theme)"
			onclick={() => selectColor('default')}
		></button>
		{#each CATEGORY_COLOR_SLOTS as slot (slot)}
			<button
				type="button"
				class="swatch"
				class:active={colorSlot === slot}
				style={`--swatch-color: var(--color-cat-${slot}-fg)`}
				aria-label={`Colour ${slot + 1}`}
				title={`Colour ${slot + 1}`}
				onclick={() => selectColor(slot)}
			></button>
		{/each}
		<button
			type="button"
			class="swatch swatch-original"
			class:active={colorSlot === 'original'}
			aria-label="Original file colour"
			title="Original (from file)"
			onclick={() => selectColor('original')}
		>
			<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
				<circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5" fill="none"/>
				<path d="M8 4 A4 4 0 0 1 8 12 Z" fill="currentColor"/>
			</svg>
		</button>
	</div>

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
		padding: var(--space-3);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		background: var(--color-surface-raised);
	}

	.color-bar {
		display: flex;
		flex-wrap: wrap;
		flex: 0 0 auto;
		gap: var(--space-1);
		padding-bottom: var(--space-3);
		margin-bottom: var(--space-3);
		border-bottom: 1px solid var(--color-border);
	}

	.swatch {
		width: 18px;
		height: 18px;
		flex: 0 0 auto;
		padding: 0;
		border-radius: 3px;
		border: 1px solid var(--color-border);
		background: var(--swatch-color);
		cursor: pointer;
	}

	.swatch-default {
		background: var(--color-fg);
	}

	.swatch-original {
		background: var(--color-bg);
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--color-fg);
	}

	.swatch-original svg {
		width: 12px;
		height: 12px;
	}

	.swatch.active {
		border-color: var(--color-border-strong);
		outline: 1px solid var(--color-border-strong);
		outline-offset: -3px;
	}

	.stage {
		flex: 1;
		min-height: 0;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		background: var(--color-surface-inset);
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
		padding-top: var(--space-3);
		margin-top: var(--space-3);
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
