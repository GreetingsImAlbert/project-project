export const projectStorageState = $state<{ usedBytes: number }>({ usedBytes: 0 });

export function initProjectStorage(usedBytes: number) {
	projectStorageState.usedBytes = usedBytes;
}

export function adjustProjectStorage(deltaBytes: number) {
	projectStorageState.usedBytes += deltaBytes;
}
