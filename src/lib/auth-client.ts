export interface AuthResponse {
	error?: string;
	message?: string;
	redirect?: string;
	requiresEmailConfirmation?: boolean;
}

export function consumeQueryFlag(currentUrl: string, name: string, expected = '1'): { active: boolean; cleanUrl: string } {
	const url = new URL(currentUrl);
	const active = url.searchParams.get(name) === expected;
	if (active) url.searchParams.delete(name);

	return {
		active,
		cleanUrl: `${url.pathname}${url.search}${url.hash}`,
	};
}

export async function withBusy<T>(setBusy: (busy: boolean) => void, action: () => Promise<T>): Promise<T> {
	setBusy(true);
	try {
		return await action();
	} finally {
		setBusy(false);
	}
}

export async function readAuthResponse(response: Response): Promise<AuthResponse> {
	const contentType = response.headers.get('content-type') ?? '';
	if (contentType.includes('application/json')) {
		return (await response.json()) as AuthResponse;
	}

	return { error: (await response.text()).trim() };
}

export function responseErrorMessage(result: AuthResponse, fallback: string): string {
	return result.error?.trim() || fallback;
}
