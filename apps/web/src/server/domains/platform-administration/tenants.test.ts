import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withUserContext } from "@hized/db";
import { cleanupFixture, createTenantWithUser, getAdminPool, type TenantFixture } from "@hized/testing";
import { hasProductAccess } from "../products/entitlements";
import {
  assertValidTimezone,
  getPlatformTenantDetail,
  listPlatformTenants,
  updateProductEntitlement,
  updateTenantConfiguration,
  updateTenantStatus,
} from "./tenants";

describe("Platform Administration tenants", () => {
  const owner = getAdminPool();
  let platformAdmin: TenantFixture;
  let managedTenant: TenantFixture;
  let managedSlug: string;

  beforeAll(async () => {
    const stamp = Date.now();
    platformAdmin = await createTenantWithUser(owner, {
      slug: `platform-admin-home-${stamp}`,
      name: "Platform Admin Home",
      email: `platform-admin-${stamp}@test.local`,
    });
    managedSlug = `platform-managed-${stamp}`;
    managedTenant = await createTenantWithUser(owner, {
      slug: managedSlug,
      name: "Managed Tenant",
      email: `managed-admin-${stamp}@test.local`,
    });
    await owner.query(
      "insert into public.platform_admins (user_id, granted_by) values ($1, $1)",
      [platformAdmin.profileId],
    );
  });

  afterAll(async () => {
    if (managedTenant) await cleanupFixture(owner, managedTenant);
    if (platformAdmin) await cleanupFixture(owner, platformAdmin);
    await owner.end();
  });

  it("lists and reads every tenant only through the Platform Admin context", async () => {
    const tenants = await withUserContext({ userId: platformAdmin.profileId }, (client) =>
      listPlatformTenants(client),
    );
    expect(tenants.some((tenant) => tenant.id === managedTenant.tenantId)).toBe(true);

    const detail = await withUserContext(
      { userId: platformAdmin.profileId, tenantId: managedTenant.tenantId },
      (client) => getPlatformTenantDetail(client, managedTenant.tenantId),
    );
    expect(detail?.tenant.name).toBe("Managed Tenant");
    expect(detail?.companyAdmins).toHaveLength(1);
    expect(detail?.entitlements).toHaveLength(3);
  });

  it("updates configuration and commercial access through audited-action primitives", async () => {
    await withUserContext(
      { userId: platformAdmin.profileId, tenantId: managedTenant.tenantId },
      async (client) => {
        await updateTenantConfiguration(client, {
          tenantId: managedTenant.tenantId,
          name: "Managed Tenant Updated",
          timezone: "Europe/London",
          financialCalendarStartMonth: 4,
          dataRetentionDays: 365,
        });
        await updateProductEntitlement(client, {
          tenantId: managedTenant.tenantId,
          productKey: "canvas",
          status: "trial",
          actorUserId: platformAdmin.profileId,
        });
      },
    );

    const { rows: [tenant] } = await owner.query(
      `select name, timezone, financial_calendar_start_month, data_retention_days
       from public.tenants where id = $1`,
      [managedTenant.tenantId],
    );
    expect(tenant).toMatchObject({
      name: "Managed Tenant Updated",
      timezone: "Europe/London",
      financial_calendar_start_month: 4,
      data_retention_days: 365,
    });
    await expect(withUserContext(
      { userId: managedTenant.profileId, tenantId: managedTenant.tenantId },
      (client) => hasProductAccess(client, { tenantId: managedTenant.tenantId, productKey: "canvas" }),
    )).resolves.toBe(true);
  });

  it("suspends tenant access at the database boundary and permits audited reactivation", async () => {
    await withUserContext(
      { userId: platformAdmin.profileId, tenantId: managedTenant.tenantId },
      (client) => updateTenantStatus(client, { tenantId: managedTenant.tenantId, status: "suspended" }),
    );

    const tenantIds = await withUserContext({ userId: managedTenant.profileId }, (client) =>
      client.query("select public.current_user_tenant_ids() as ids").then((result) => result.rows[0].ids as string[]),
    );
    expect(tenantIds).not.toContain(managedTenant.tenantId);

    const authority = await withUserContext(
      { userId: managedTenant.profileId, tenantId: managedTenant.tenantId },
      (client) => client.query(
        `select public.current_user_has_tenant_access($1) as member,
                public.is_company_admin($1) as company_admin,
                (select count(*)::integer from public.tenant_memberships where tenant_id = $1) as visible_members`,
        [managedTenant.tenantId],
      ).then((result) => result.rows[0]),
    );
    expect(authority).toEqual({ member: false, company_admin: false, visible_members: 0 });
    await expect(withUserContext(
      { userId: managedTenant.profileId, tenantId: managedTenant.tenantId },
      (client) => hasProductAccess(client, { tenantId: managedTenant.tenantId, productKey: "pulse" }),
    )).resolves.toBe(false);

    const { rows: membershipRows } = await owner.query(
      "select * from public.get_membership_for_slug($1, $2)",
      [managedTenant.profileId, managedSlug],
    );
    expect(membershipRows).toHaveLength(0);

    await withUserContext(
      { userId: platformAdmin.profileId, tenantId: managedTenant.tenantId },
      (client) => updateTenantStatus(client, { tenantId: managedTenant.tenantId, status: "active" }),
    );
    await expect(withUserContext(
      { userId: managedTenant.profileId, tenantId: managedTenant.tenantId },
      (client) => hasProductAccess(client, { tenantId: managedTenant.tenantId, productKey: "pulse" }),
    )).resolves.toBe(true);
  });

  it("rejects invalid time zones before writing", () => {
    expect(() => assertValidTimezone("Europe/London")).not.toThrow();
    expect(() => assertValidTimezone("Not/A_Timezone")).toThrow(/valid IANA time zone/);
  });
});
