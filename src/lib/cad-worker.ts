// Off the main thread: every mesh loader here is CPU-heavy enough on a large enough file to
// freeze the tab for seconds if parsed inline — STEP/IGES because OpenCASCADE's WASM build
// (occt-import-js) is tessellating a boundary representation into triangles, STL/OBJ/PLY/3MF
// because a big triangle soup is itself slow to parse into typed arrays. One message in, one
// response out — CadViewer's loadModel spins up a fresh worker per file rather than keeping
// one alive, so cancelling a load (another file opened, or the panel closed) is just
// terminating it.
import occtimportjs from 'occt-import-js';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';

export interface CadWorkerMesh {
	position: Float32Array;
	normal: Float32Array | null;
	// Null for the group-format loaders (STL/OBJ/PLY commonly hand back non-indexed
	// geometry) — CadViewer only calls geometry.setIndex when this is present.
	index: Uint32Array | null;
	color: [number, number, number] | null;
}

export interface CadWorkerRequest {
	format: 'step' | 'iges' | 'stl' | 'obj' | 'ply' | '3mf';
	buffer: ArrayBuffer;
	// Resolved by the caller against `window.location`, not here: a worker's own notion of its
	// base URL (`import.meta.url`/`self.location`) has turned out not to be trustworthy in
	// every deployment this app runs under (it's thrown "Invalid URL" building on it directly),
	// while the main thread's `window.location` always is. So this arrives fully absolute, and
	// this file never constructs a URL of its own. Only read for step/iges, since that's the
	// only format that needs occt-import-js's WASM.
	wasmUrl: string;
}

export type CadWorkerResponse = { success: true; meshes: CadWorkerMesh[] } | { success: false; error: string };

// `self` is typed as `Window` here — this file never gets the `webworker` lib (that would
// conflict with the `dom` lib every other browser file in the project relies on) — but a
// worker's global scope has the same postMessage/onmessage/onerror shape the parent's own
// Worker handle does, so the cast is purely to get past that, not a claim about what `self`
// actually is.
const ctx = self as unknown as Worker;

// Emscripten aborts often throw a plain string (or an object with a `message`, not a real
// Error) rather than throwing an actual Error instance — `e instanceof Error` alone would
// silently swap a specific reason for a useless generic one.
function describeError(e: unknown): string {
	if (e instanceof Error) return e.message;
	if (typeof e === 'string') return e;
	if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') {
		return (e as { message: string }).message;
	}
	return 'Could not read this model';
}

let occtPromise: ReturnType<typeof occtimportjs> | null = null;

// Cached rather than re-initialised: this worker only ever handles one file (a fresh one is
// spun up per load), but a lazy singleton here is what future-proofs that without this file
// having to know CadViewer's lifecycle.
function getOcct(wasmUrl: string) {
	occtPromise ??= occtimportjs({ locateFile: () => wasmUrl });
	return occtPromise;
}

function meshFromGeometry(geometry: THREE.BufferGeometry, color: [number, number, number] | null): CadWorkerMesh {
	const position = geometry.getAttribute('position');
	const normal = geometry.getAttribute('normal');
	const index = geometry.getIndex();
	return {
		position: Float32Array.from(position.array as ArrayLike<number>),
		normal: normal ? Float32Array.from(normal.array as ArrayLike<number>) : null,
		index: index ? Uint32Array.from(index.array as ArrayLike<number>) : null,
		color,
	};
}

// OBJLoader and ThreeMFLoader hand back a Group of Meshes rather than one geometry — STL and
// PLY parse to a single BufferGeometry instead, handled directly in the switch below.
function meshesFromObject(obj: THREE.Object3D, keepColor: boolean): CadWorkerMesh[] {
	const meshes: CadWorkerMesh[] = [];
	obj.traverse((node) => {
		const mesh = node as THREE.Mesh;
		if (!mesh.isMesh) return;

		let color: [number, number, number] | null = null;
		if (keepColor) {
			const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
			const c = (material as THREE.MeshStandardMaterial | undefined)?.color;
			if (c) color = [c.r, c.g, c.b];
		}

		meshes.push(meshFromGeometry(mesh.geometry, color));
	});
	return meshes;
}

ctx.onmessage = async (ev: MessageEvent<CadWorkerRequest>) => {
	const { format, buffer, wasmUrl } = ev.data;

	try {
		let meshes: CadWorkerMesh[];

		if (format === 'step' || format === 'iges') {
			const occt = await getOcct(wasmUrl);
			const content = new Uint8Array(buffer);
			const params = { linearUnit: 'millimeter' as const };
			const result = format === 'step' ? occt.ReadStepFile(content, params) : occt.ReadIgesFile(content, params);

			if (!result.success) {
				ctx.postMessage({ success: false, error: 'This file has no readable geometry' } satisfies CadWorkerResponse);
				return;
			}

			// One mesh per solid, same granularity occt-import-js itself hands back. Per-face
			// colour (`brep_faces` in the raw result) isn't carried over — most mechanical STEP
			// exports have no colour at all, and CadViewer already has a neutral fallback
			// material for that case.
			meshes = result.meshes.map((mesh) => ({
				position: Float32Array.from(mesh.attributes.position.array),
				normal: mesh.attributes.normal ? Float32Array.from(mesh.attributes.normal.array) : null,
				index: Uint32Array.from(mesh.index.array),
				color: mesh.color ?? null,
			}));
		} else if (format === 'stl') {
			// Handles both the binary and the ASCII flavour off the same buffer.
			meshes = [meshFromGeometry(new STLLoader().parse(buffer), null)];
		} else if (format === 'ply') {
			meshes = [meshFromGeometry(new PLYLoader().parse(buffer), null)];
		} else if (format === 'obj') {
			// The only text format here, and the only one that can reference a .mtl we have no
			// way to fetch — so its materials are discarded, same as CadViewer did on the main
			// thread before this moved here.
			meshes = meshesFromObject(new OBJLoader().parse(new TextDecoder().decode(buffer)), false);
		} else {
			// 3MF is the one group format that carries real per-object colour worth keeping.
			meshes = meshesFromObject(new ThreeMFLoader().parse(buffer), true);
		}

		const transfer = meshes.flatMap((m) => {
			const buffers = [m.position.buffer];
			if (m.normal) buffers.push(m.normal.buffer);
			if (m.index) buffers.push(m.index.buffer);
			return buffers;
		});
		ctx.postMessage({ success: true, meshes } satisfies CadWorkerResponse, transfer);
	} catch (e) {
		ctx.postMessage({ success: false, error: describeError(e) } satisfies CadWorkerResponse);
	}
};
