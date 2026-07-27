-- Small companion to 0008: resolving a tenant's id from its slug for
-- audit-logging purposes on a cross-tenant denial, regardless of whether
-- the caller has membership there. Non-sensitive (existence of a slug
-- isn't secret — the caller already gets an identical "forbidden"
-- response either way) and needed so the denial's audit_log insert can
-- satisfy "tenant_id = current_tenant_id()" without granting the caller
-- any actual read/write access to that tenant's other data.
create or replace function public.get_tenant_id_by_slug(p_slug text)
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.tenants where slug = p_slug
$$;
