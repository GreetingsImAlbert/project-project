// Decimal (SI) units, not binary — matches how R2's dashboard/billing report
// usage (1 GB = 1,000,000,000 bytes), same convention as S3/GCS.
export function formatBytes(bytes: number): string {
	const gb = bytes / 1_000_000_000;
	if (gb >= 1) return `${gb.toFixed(2)} GB`;
	const mb = bytes / 1_000_000;
	return `${mb.toFixed(1)} MB`;
}
