export const storageUsageState = $state<{ usedBytes: number }>({ usedBytes: 0 });

export function initStorageUsage(usedBytes: number) {
	storageUsageState.usedBytes = usedBytes;
}

export function adjustStorageUsage(deltaBytes: number) {
	storageUsageState.usedBytes += deltaBytes;
}
