-- A passkey is bound to the Relying Party ID it was created under — the domain.
-- Move the app to a new hostname and every stored credential silently stops being
-- offered by the authenticator, and nothing in the row says so.
--
-- That matters because the enrollment gate asks "is the credentials table empty?"
-- to decide whether the enroll code applies. After a domain move the answer is
-- "no" — for credentials that can never be used again. The escape hatch stays
-- shut and there is no way back into the archive from either hostname.
--
-- Recording the RP ID lets the gate ask the question that actually matters: is
-- there a credential that still works HERE?

alter table credentials add column rp_id text;

-- Fail loudly rather than mislabelling every existing passkey. migrate.ts binds
-- this; an unset value means the runner is older than this migration.
do $$
begin
  if current_setting('legible.rp_id', true) is null then
    raise exception 'legible.rp_id is not set — migrate.ts must bind it before applying 005';
  end if;
end $$;

-- Everything already stored was registered under the RP ID in force right now.
-- This runs once, before any domain move, so the label is correct by construction.
update credentials set rp_id = current_setting('legible.rp_id', true);

alter table credentials alter column rp_id set not null;

create index if not exists credentials_rp_id_idx on credentials (rp_id);
