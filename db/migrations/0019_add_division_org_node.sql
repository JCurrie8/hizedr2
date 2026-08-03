-- Divisions are a first-class organisation level in blueprint v2.1.
-- This widens only the existing node-type check; tenant isolation and
-- effective-dated hierarchy policies continue to apply unchanged.

alter table public.org_nodes
  drop constraint org_nodes_node_type_check;

alter table public.org_nodes
  add constraint org_nodes_node_type_check
  check (node_type in
    ('company','division','function','department','region','site','team','employee'));
