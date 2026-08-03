-- membership_scopes remains many-to-many for dotted-line access, but a
-- membership has exactly zero or one primary scope. Company Admins use zero
-- because their role is tenant-wide; every other active role is assigned one
-- by the application access-management workflow.

create unique index membership_scopes_one_primary_idx
  on public.membership_scopes (membership_id)
  where is_primary;
