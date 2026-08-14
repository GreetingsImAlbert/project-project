const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type OwnershipTransferInput = { newOwnerId: string } | { error: string };

export function parseOwnershipTransfer(formData: FormData, currentOwnerId: string): OwnershipTransferInput {
	const newOwnerId = formData.get('newOwnerId')?.toString().trim();

	if (!newOwnerId || !UUID_PATTERN.test(newOwnerId)) {
		return { error: 'Choose a project member' };
	}
	if (newOwnerId === currentOwnerId) {
		return { error: 'Choose another project member as the new owner' };
	}

	return { newOwnerId };
}

export function ownershipTransferStatus(message: string): number | null {
	if (message.includes('Project not found')) return 404;
	if (message.includes('Only the current project owner')) return 403;
	if (
		message.includes('Choose another project member') ||
		message.includes('must be a current project member') ||
		message.includes('account deletion pending')
	) return 400;
	return null;
}
