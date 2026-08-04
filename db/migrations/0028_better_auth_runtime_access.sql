-- Better Auth is the trusted identity boundary and queries these tables
-- server-side through the restricted runtime role. They are global auth
-- records, not tenant-owned application data, so tenant RLS must never be
-- enabled on them. Production drift had enabled RLS with no policies on all
-- five tables, causing app_user to see zero identities and every login to
-- fail closed as "User not found".

alter table public."user" disable row level security;
alter table public."session" disable row level security;
alter table public."account" disable row level security;
alter table public."verification" disable row level security;
alter table public."twoFactor" disable row level security;

-- PostgreSQL normally grants no table privileges to PUBLIC, but make the
-- trusted-boundary assumption explicit: only named database roles receive
-- access, and app_user is the server-only Better Auth runtime principal.
revoke all on table
  public."user",
  public."session",
  public."account",
  public."verification",
  public."twoFactor"
from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_user') then
    grant select, insert, update, delete on table
      public."user",
      public."session",
      public."account",
      public."verification",
      public."twoFactor"
    to app_user;
  end if;
end
$$;
