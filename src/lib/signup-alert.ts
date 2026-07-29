// Supabase's SMTP (Resend) only covers the emails Supabase itself sends to the
// signing-up user (confirmation, password reset) — it has no concept of also
// notifying a third party. This hits Resend's API directly instead. Best-effort:
// swallows its own errors so a Resend outage never fails a signup.
export async function alertSignup(env: Env, email: string, displayName: string) {
	try {
		const res = await fetch('https://api.resend.com/emails', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${env.RESEND_API_KEY}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				from: env.ALERT_EMAIL_FROM,
				to: env.ALERT_EMAIL_TO,
				subject: `P2 signup: ${displayName}`,
				text: `${displayName} <${email}> just signed up.`,
			}),
		});
		if (!res.ok) {
			console.log(`[signup-alert] Resend responded ${res.status}: ${await res.text()}`);
		}
	} catch (error) {
		console.log(`[signup-alert] failed to send: ${(error as Error).message}`);
	}
}
