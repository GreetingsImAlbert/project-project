// Off the main thread: OpenCASCADE's WASM build (occt-import-js) tessellates a STEP/IGES
// boundary representation into triangles, which is CPU-heavy enough on a real assembly to
// freeze the tab for seconds if done inline. One message in, one response out — CadViewer's
// loadBrepModel spins up a fresh worker per file rather than keeping one alive, so cancelling
// a load (another file opened, or the panel closed) is just terminating it.
import occtimportjs from 'occt-import-js';

export interface CadWorkerMesh {
	position: Float32Array;
	normal: Float32Array | null;
	index: Uint32Array;
	color: [number, number, number] | null;
}

export interface CadWorkerRequest {
	format: 'step' | 'iges';
	buffer: ArrayBuffer;
	// Resolved by the caller against `window.location`, not here: a worker's own notion of its
	// base URL (`import.meta.url`/`self.location`) has turned out not to be trustworthy in
	// every deployment this app runs under (it's thrown "Invalid URL" building on it directly),
	// while the main thread's `window.location` always is. So this arrives fully absolute, and
	// this file never constructs a URL of its own.
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

ctx.onmessage = async (ev: MessageEvent<CadWorkerRequest>) => {
	const { format, buffer, wasmUrl } = ev.data;

	try {
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
		// exports have no colour at all, and CadViewer already has a neutral fallback material
		// for that case.
		const meshes: CadWorkerMesh[] = result.meshes.map((mesh) => ({
			position: Float32Array.from(mesh.attributes.position.array),
			normal: mesh.attributes.normal ? Float32Array.from(mesh.attributes.normal.array) : null,
			index: Uint32Array.from(mesh.index.array),
			color: mesh.color ?? null,
		}));

		const transfer = meshes.flatMap((m) => (m.normal ? [m.position.buffer, m.normal.buffer, m.index.buffer] : [m.position.buffer, m.index.buffer]));
		ctx.postMessage({ success: true, meshes } satisfies CadWorkerResponse, transfer);
	} catch (e) {
		ctx.postMessage({ success: false, error: describeError(e) } satisfies CadWorkerResponse);
	}
};
