-- Same bug shape as 0006, found by inspection before building the audit
-- log viewer UI on top of it — audit_log is the single most sensitive
-- table in the schema, so this is worth catching before, not after.
--
-- "audit_log: admin-only select" checked is_company_admin(tenant_id)
-- against the ROW's own tenant, independent of current_tenant_id() —
-- exactly the pattern 0006 fixed for write policies. A company_admin of
-- more than one tenant (Hized consultancy staff, by design) would see
-- every tenant's audit trail they administer at once, regardless of
-- which tenant the session was actually scoped to.

drop policy "audit_log: admin-only select" on public.audit_log;
create policy "audit_log: admin-only select"
on public.audit_log for select
using (
  public.is_platform_admin()
  or (tenant_id = public.current_tenant_id() and public.is_company_admin(tenant_id))
);
