-- Email/password signups reserve a MAX_USERS slot through their profiles row as
-- soon as auth.users is inserted. Release that reservation when confirmation has
-- not happened within 15 minutes. The one-minute cadence bounds the actual age
-- at deletion to roughly 15-16 minutes.
create extension if not exists pg_cron;

select cron.schedule(
	'purge-stale-unconfirmed-users',
	'* * * * *',
	$$
		delete from auth.users
		where email is not null
		  and email_confirmed_at is null
		  and created_at < now() - interval '15 minutes';
	$$
);
