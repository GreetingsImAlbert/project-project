import { ProjectImportError, type ParsedProjectZip } from './project-import';
import type { ProjectExportManifestV1 } from './project-export';
import type { RemappedProjectImport } from './project-import-remap';

export interface ProjectImportBucket {
	put(
		key: string,
		value: Uint8Array,
		options?: { httpMetadata?: { contentType?: string } },
	): Promise<unknown>;
	delete(key: string): Promise<void>;
}

export interface StagedProjectFile {
	sourceFileId: string;
	fileId: string;
	r2Key: string;
	bytes: number;
}

export interface StagedProjectFiles {
	files: StagedProjectFile[];
}

async function deleteKeys(bucket: ProjectImportBucket, keys: string[]): Promise<void> {
	const results = await Promise.allSettled(keys.map((key) => bucket.delete(key)));
	const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
	if (failures.length > 0) {
		console.error(`[project-import] Could not clean up ${failures.length} staged storage object(s).`);
	}
}

/**
 * Writes validated archive content to fresh project-scoped R2 keys in sequence.
 * Sequential puts keep the Worker from multiplying the archive's memory use;
 * the ZIP parser has already bounded every entry and verified its checksum.
 */
export async function stageProjectImportFiles(
	archive: ParsedProjectZip,
	manifest: ProjectExportManifestV1,
	remapped: RemappedProjectImport,
	bucket: ProjectImportBucket,
): Promise<StagedProjectFiles> {
	const staged: StagedProjectFile[] = [];
	try {
		for (const sourceFile of manifest.records.files) {
			const entry = archive.entries.get(sourceFile.archive_path);
			if (!entry || entry.isDirectory) throw new ProjectImportError('Import file content is missing from the validated archive.');

			const fileId = remapped.maps.fileIdsBySourceId.get(sourceFile.id);
			if (!fileId) throw new ProjectImportError('Import file ID remapping is missing.');
			const destination = remapped.payload.files.find((file) => file.id === fileId);
			if (!destination) throw new ProjectImportError('Import file destination is missing.');
			if (entry.bytes.length !== destination.size_bytes) throw new ProjectImportError('Import file size changed before staging.');

			await bucket.put(destination.r2_key, entry.bytes, {
				httpMetadata: destination.mime_type ? { contentType: destination.mime_type } : undefined,
			});
			staged.push({
				sourceFileId: sourceFile.id,
				fileId,
				r2Key: destination.r2_key,
				bytes: entry.bytes.length,
			});
		}
		return { files: staged };
	} catch (error) {
		await deleteKeys(bucket, staged.map((file) => file.r2Key));
		if (error instanceof ProjectImportError) throw error;
		throw new ProjectImportError('Could not stage imported files in storage.');
	}
}

export async function deleteStagedProjectFiles(bucket: ProjectImportBucket, staged: StagedProjectFiles): Promise<void> {
	await deleteKeys(bucket, staged.files.map((file) => file.r2Key));
}
