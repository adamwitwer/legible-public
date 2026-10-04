-- A session remembers which passkey opened it.
--
-- Without this, :forget removed a passkey and left every session it had opened
-- alive for the rest of SESSION_DAYS. Forgetting a lost phone's passkey is the
-- obvious response to losing the phone, and it did not sign the phone out: the
-- cookie on it kept working for up to 90 days.
--
-- With the link, deleting a credential cascades to its sessions.
--
-- Sessions issued before this migration carry NULL here, since nothing recorded
-- which passkey opened them. The forget route ends those too (all but the
-- caller's own), because there is no telling which of them belongs to the
-- device being forgotten. That costs one passkey tap on another device, once.
-- New logins all carry the link, so the NULL rows age out within SESSION_DAYS.

alter table sessions
  add column credential_id text references credentials(id) on delete cascade;

create index if not exists sessions_credential_idx on sessions (credential_id);
