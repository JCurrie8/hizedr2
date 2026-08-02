-- profiles.full_name was never populated at provisioning time, even
-- though Better Auth already captures a name at signup — found while
-- verifying the audit log viewer, which showed "system" instead of the
-- actor's name. accept_invitation_by_email() now copies it from "user".
create or replace function public.accept_invitation_by_email(p_auth_user_id text, p_email citext)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_invitation record;
  v_profile_id uuid;
  v_membership_id uuid;
  v_name text;
begin
  select id, tenant_id, role, org_node_id into v_invitation
  from public.invitations
  where email = p_email and status = 'pending' and expires_at > now()
  order by created_at desc
  limit 1
  for update;

  if not found then
    raise exception 'no pending invitation for %', p_email;
  end if;

  select name into v_name from "user" where id = p_auth_user_id;

  insert into public.profiles (auth_user_id, full_name)
  values (p_auth_user_id, v_name)
  returning id into v_profile_id;

  insert into public.tenant_memberships (tenant_id, user_id, role, status)
  values (v_invitation.tenant_id, v_profile_id, v_invitation.role, 'active')
  returning id into v_membership_id;

  if v_invitation.org_node_id is not null then
    insert into public.membership_scopes (membership_id, org_node_id, is_primary)
    values (v_membership_id, v_invitation.org_node_id, true);
  end if;

  update public.invitations set status = 'accepted' where id = v_invitation.id;

  insert into public.audit_log (tenant_id, actor_user_id, action, target_type, target_id, metadata)
  values (v_invitation.tenant_id, v_profile_id, 'invitation.accepted', 'invitation', v_invitation.id::text,
    jsonb_build_object('role', v_invitation.role));

  return v_profile_id;
end;
$$;
