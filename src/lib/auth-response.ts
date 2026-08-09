export function wantsJson(request: Request): boolean {
	return request.headers
		.get('accept')
		?.split(',')
		.some((value) => value.trim().toLowerCase().startsWith('application/json')) ?? false;
}

export function authErrorResponse(request: Request, message: string, status: number): Response {
	if (wantsJson(request)) {
		return Response.json({ error: message }, { status });
	}

	return new Response(message, { status });
}
