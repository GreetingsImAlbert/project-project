// occt-import-js ships no types (see node_modules/occt-import-js/package.json) — this
// covers only the surface CadWorker actually calls. Shape taken from the package README.
declare module 'occt-import-js' {
	interface OcctMeshAttribute {
		array: number[];
	}

	interface OcctMesh {
		name: string;
		color?: [number, number, number];
		attributes: {
			position: OcctMeshAttribute;
			normal?: OcctMeshAttribute;
		};
		index: OcctMeshAttribute;
	}

	interface OcctReadResult {
		success: boolean;
		meshes: OcctMesh[];
	}

	interface OcctReadParams {
		linearUnit?: 'millimeter' | 'centimeter' | 'meter' | 'inch' | 'foot';
		linearDeflectionType?: 'bounding_box_ratio' | 'absolute_value';
		linearDeflection?: number;
		angularDeflection?: number;
	}

	interface OcctInstance {
		ReadStepFile(content: Uint8Array, params: OcctReadParams | null): OcctReadResult;
		ReadIgesFile(content: Uint8Array, params: OcctReadParams | null): OcctReadResult;
	}

	interface OcctModuleOptions {
		locateFile?: (path: string) => string;
	}

	export default function occtimportjs(options?: OcctModuleOptions): Promise<OcctInstance>;
}
