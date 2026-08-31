-- WebAuthn challenges were stored under a fixed id: one row called 'register',
-- one called 'authenticate'. That made the pending challenge a single shared
-- slot, and the slot was writable by anyone.
--
-- POST /api/auth/login/start needs no credential and no session. An
-- unauthenticated caller could hit it in a loop, overwriting the row each time.
-- The real user's authenticator would sign the challenge it was handed, and by
-- the time /login/finish looked the row up it held a stranger's challenge
-- instead — verification failed, every time, for as long as the loop ran. No
-- credential, no session, no rate limit: a remote lockout from the archive.
--
-- Keying each row by its own challenge value gives every ceremony a private
-- row. Concurrent ceremonies stop colliding, and an abandoned one is just a row
-- that expires.

-- The two legacy rows are keyed by kind, so they can never match a challenge
-- lookup again. Any ceremony in flight during this deploy has to be retried
-- regardless; that is a page refresh, not lost data.
delete from challenges where id in ('register', 'authenticate');

-- putChallenge sweeps expired rows on every write, and abandoned ceremonies are
-- the normal case now rather than an anomaly — an index keeps that sweep from
-- turning into a sequential scan as the table churns.
create index if not exists challenges_expires_idx on challenges (expires_at);
