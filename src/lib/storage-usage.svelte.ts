export const storageUsageState = $state<{ usedBytes: number; failed: boolean }>({ usedBytes: 0, failed: false });

export function initStorageUsage(usedBytes: number, failed = false) {
	storageUsageState.usedBytes = usedBytes;
	storageUsageState.failed = failed;
}

export function adjustStorageUsage(deltaBytes: number) {
	storageUsageState.usedBytes += deltaBytes;
}
