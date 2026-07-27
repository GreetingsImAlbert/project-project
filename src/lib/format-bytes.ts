// Decimal (SI) units, not binary — matches how R2's dashboard/billing report
// usage (1 GB = 1,000,000,000 bytes), same convention as S3/GCS.
export function formatBytes(bytes: number): string {
	const gb = bytes / 1_000_000_000;
	if (gb >= 1) return `${gb.toFixed(2)} GB`;
	const mb = bytes / 1_000_000;
	return `${mb.toFixed(1)} MB`;
}

// Same units, but keeps small sizes readable — a text file is 0.0 MB under
// formatBytes, which is the wrong answer for a per-file or per-folder figure.
export function formatFileSize(bytes: number): string {
	if (bytes < 1_000) return `${Math.round(bytes)} B`;
	if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
	return formatBytes(bytes);
}
