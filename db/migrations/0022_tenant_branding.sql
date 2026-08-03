-- Tenant branding is split into published and draft rows so ordinary tenant
-- members can only read the theme that is actually live. Company Admins can
-- preview/edit a draft, then publish it transactionally with an audit event.
-- Platform Administration never reads either table and remains Hized-branded.

create table public.tenant_branding (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  logo_object_key text,
  logo_content_type text check (logo_content_type in ('image/png', 'image/webp')),
  primary_color text not null default '#0F2A43'
    check (primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  accent_color text not null default '#0E7C80'
    check (accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  typography text not null default 'hized'
    check (typography in ('hized', 'clean', 'geometric')),
  published_by uuid references public.profiles(id),
  published_at timestamptz not null default now(),
  check ((logo_object_key is null) = (logo_content_type is null)),
  check (logo_object_key is null or length(logo_object_key) between 1 and 500)
);

create table public.tenant_branding_drafts (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  logo_object_key text,
  logo_content_type text check (logo_content_type in ('image/png', 'image/webp')),
  primary_color text not null default '#0F2A43'
    check (primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  accent_color text not null default '#0E7C80'
    check (accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  typography text not null default 'hized'
    check (typography in ('hized', 'clean', 'geometric')),
  updated_by uuid not null references public.profiles(id),
  updated_at timestamptz not null default now(),
  check ((logo_object_key is null) = (logo_content_type is null)),
  check (logo_object_key is null or length(logo_object_key) between 1 and 500)
);

alter table public.tenant_branding enable row level security;
alter table public.tenant_branding_drafts enable row level security;

-- One complete current-tenant predicate per command. Do not broaden these
-- policies with a role check that is independent of current_tenant_id(): that
-- would recreate the multi-tenant-admin leak fixed in migrations 0006/0011.
create policy "tenant branding: current active member reads published"
on public.tenant_branding for select
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
);

create policy "tenant branding: current company admin inserts"
on public.tenant_branding for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and public.is_company_admin(tenant_id)
);

create policy "tenant branding: current company admin updates"
on public.tenant_branding for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and public.is_company_admin(tenant_id)
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and public.is_company_admin(tenant_id)
);

create policy "tenant branding drafts: current company admin reads"
on public.tenant_branding_drafts for select
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and public.is_company_admin(tenant_id)
);

create policy "tenant branding drafts: current company admin inserts"
on public.tenant_branding_drafts for insert
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and public.is_company_admin(tenant_id)
);

create policy "tenant branding drafts: current company admin updates"
on public.tenant_branding_drafts for update
using (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and public.is_company_admin(tenant_id)
)
with check (
  tenant_id = public.current_tenant_id()
  and public.current_user_has_tenant_access(tenant_id)
  and public.is_company_admin(tenant_id)
);
