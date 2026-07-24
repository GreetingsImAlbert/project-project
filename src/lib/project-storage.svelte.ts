export const projectStorageState = $state<{ usedBytes: number; failed: boolean }>({ usedBytes: 0, failed: false });

export function initProjectStorage(usedBytes: number, failed = false) {
	projectStorageState.usedBytes = usedBytes;
	projectStorageState.failed = failed;
}

export function adjustProjectStorage(deltaBytes: number) {
	projectStorageState.usedBytes += deltaBytes;
}
