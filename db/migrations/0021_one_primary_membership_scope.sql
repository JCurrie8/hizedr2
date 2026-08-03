-- membership_scopes remains many-to-many for dotted-line access, but a
-- membership has exactly zero or one primary scope. Company Admins use zero
-- because their role is tenant-wide; every other active role is assigned one
-- by the application access-management workflow.

-- Before the primary flag had any UI meaning, the default `true` allowed
-- legacy memberships to accumulate several primary rows. Preserve every
-- scope (and therefore every permission) while choosing one deterministic
-- primary: the shallowest active hierarchy node, then UUID as a stable tie
-- breaker. Inactive/missing versions sort last. All remaining rows become
-- secondary scopes; none are deleted.
with ranked_primary_scopes as (
  select
    s.membership_id,
    s.org_node_id,
    row_number() over (
      partition by s.membership_id
      order by nlevel(v.path) asc nulls last, s.org_node_id
    ) as primary_rank
  from public.membership_scopes s
  left join public.org_node_versions v
    on v.org_node_id = s.org_node_id
   and v.valid_from <= current_date
   and (v.valid_to is null or v.valid_to > current_date)
  where s.is_primary
)
update public.membership_scopes s
set is_primary = false
from ranked_primary_scopes ranked
where ranked.membership_id = s.membership_id
  and ranked.org_node_id = s.org_node_id
  and ranked.primary_rank > 1;

create unique index membership_scopes_one_primary_idx
  on public.membership_scopes (membership_id)
  where is_primary;
