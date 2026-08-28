import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withUserContext } from "@hized/db";
import { cleanupFixture, createTenantWithUser, getAdminPool, type TenantFixture } from "./fixtures";

describe("outbound SQL gateway RLS and direct-write boundary", () => {
  const admin = getAdminPool();
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  let employee: { profileId: string; authUserId: string };
  let gatewayId: string;
  let jobId: string;

  beforeAll(async () => {
    const stamp = Date.now();
    tenantA = await createTenantWithUser(admin, { slug: `gateway-a-${stamp}`, name: "Gateway A", email: `gateway-a-${stamp}@test.local` });
    tenantB = await createTenantWithUser(admin, { slug: `gateway-b-${stamp}`, name: "Gateway B", email: `gateway-b-${stamp}@test.local` });
    await admin.query(
      "update public.tenant_product_entitlements set status = 'trial' where tenant_id = any($1::uuid[]) and product_key = 'connect'",
      [[tenantA.tenantId, tenantB.tenantId]],
    );
    const { rows: [authUser] } = await admin.query(
      `insert into "user" (id, name, email, "emailVerified")
       values (gen_random_uuid()::text, 'Gateway employee', $1, true) returning id`,
      [`gateway-employee-${stamp}@test.local`],
    );
    const { rows: [profile] } = await admin.query(
      "insert into public.profiles (auth_user_id) values ($1) returning id",
      [authUser.id],
    );
    employee = { profileId: profile.id, authUserId: authUser.id };
    await admin.query(
      "insert into public.tenant_memberships (tenant_id, user_id, role) values ($1,$2,'employee')",
      [tenantA.tenantId, employee.profileId],
    );
    const { rows: [connector] } = await admin.query(
      `insert into public.connectors
         (tenant_id, connector_type, name, status, auth_mode, config, created_by)
       values ($1,'sql_server','Gateway RLS connector','active','none',
               jsonb_build_object('direction','source','networkMode','gateway'),$2)
       returning id`,
      [tenantA.tenantId, tenantA.profileId],
    );
    const { rows: [gateway] } = await admin.query(
      `insert into public.connector_gateways
         (tenant_id, name, connector_name, status, enrollment_token_hash,
          enrollment_expires_at, device_token_hash, connector_id, created_by)
       values ($1,'RLS gateway','Gateway RLS connector','active',repeat('a',64),
               now() + interval '10 minutes',repeat('b',64),$2,$3)
       returning id`,
      [tenantA.tenantId, connector.id, tenantA.profileId],
    );
    gatewayId = gateway.id;
    await admin.query(
      `update public.connectors
          set config = config || jsonb_build_object('gatewayId',$2::text)
        where id = $1`,
      [connector.id, gatewayId],
    );
    const { rows: [query] } = await admin.query(
      `insert into public.sql_analysis_queries
         (tenant_id, connector_id, name, sql_text, query_hash, created_by, updated_by)
       values ($1,$2,'Gateway RLS query','select governed rows',repeat('c',64),$3,$3)
       returning id`,
      [tenantA.tenantId, connector.id, tenantA.profileId],
    );
    const { rows: [job] } = await admin.query(
      `insert into public.connector_gateway_jobs
         (tenant_id, gateway_id, connector_id, query_id, kind, actor_user_id)
       values ($1,$2,$3,$4,'sql_analysis',$5) returning id`,
      [tenantA.tenantId, gatewayId, connector.id, query.id, tenantA.profileId],
    );
    jobId = job.id;
  });

  afterAll(async () => {
    await cleanupFixture(admin, tenantA);
    await admin.query("delete from public.profiles where id = $1", [employee.profileId]);
    await admin.query(`delete from "user" where id = $1`, [employee.authUserId]);
    await cleanupFixture(admin, tenantB);
    await admin.end();
  });

  it("shows gateway state only to a selected-tenant Connect operator", async () => {
    const [adminView, employeeView, otherTenantView, borrowedView] = await Promise.all([
      withUserContext({ userId: tenantA.profileId, tenantId: tenantA.tenantId }, async (client) => ({
        gateways: await client.query("select id from public.connector_gateways where id = $1", [gatewayId]).then((result) => result.rows),
        jobs: await client.query("select id from public.connector_gateway_jobs where id = $1", [jobId]).then((result) => result.rows),
      })),
      withUserContext({ userId: employee.profileId, tenantId: tenantA.tenantId }, async (client) => ({
        gateways: await client.query("select id from public.connector_gateways where id = $1", [gatewayId]).then((result) => result.rows),
        jobs: await client.query("select id from public.connector_gateway_jobs where id = $1", [jobId]).then((result) => result.rows),
      })),
      withUserContext({ userId: tenantB.profileId, tenantId: tenantB.tenantId }, (client) => client.query(
        "select id from public.connector_gateways where id = $1", [gatewayId],
      ).then((result) => result.rows)),
      withUserContext({ userId: tenantB.profileId, tenantId: tenantA.tenantId }, (client) => client.query(
        "select id from public.connector_gateways where id = $1", [gatewayId],
      ).then((result) => result.rows)),
    ]);
    expect(adminView.gateways).toHaveLength(1);
    expect(adminView.jobs).toHaveLength(1);
    expect(employeeView).toEqual({ gateways: [], jobs: [] });
    expect(otherTenantView).toHaveLength(0);
    expect(borrowedView).toHaveLength(0);
  });

  it("denies direct app-role writes even to a Company Admin", async () => {
    await expect(withUserContext({ userId: tenantA.profileId, tenantId: tenantA.tenantId }, (client) => client.query(
      "update public.connector_gateways set status = 'revoked' where id = $1", [gatewayId],
    ))).rejects.toThrow(/permission denied/);
    await expect(withUserContext({ userId: tenantA.profileId, tenantId: tenantA.tenantId }, (client) => client.query(
      "delete from public.connector_gateway_jobs where id = $1", [jobId],
    ))).rejects.toThrow(/permission denied/);
    await expect(withUserContext({ userId: tenantA.profileId, tenantId: tenantA.tenantId }, (client) => client.query(
      "select enrollment_token_hash, device_token_hash from public.connector_gateways where id = $1", [gatewayId],
    ))).rejects.toThrow(/permission denied/);
    await expect(withUserContext({ userId: tenantA.profileId, tenantId: tenantA.tenantId }, (client) => client.query(
      "select lease_token_hash from public.connector_gateway_jobs where id = $1", [jobId],
    ))).rejects.toThrow(/permission denied/);
  });

  it("does not authenticate an unknown enrollment or device hash", async () => {
    const result = await withUserContext({ userId: null }, async (client) => ({
      enrollment: await client.query(
        "select * from public.begin_connector_gateway_enrollment($1)", ["f".repeat(64)],
      ).then((value) => value.rows),
      device: await client.query(
        "select * from public.claim_connector_gateway_job($1,$2)", ["e".repeat(64), "d".repeat(64)],
      ).then((value) => value.rows),
      authenticated: await client.query(
        "select public.authenticate_connector_gateway_device($1) as value", ["e".repeat(64)],
      ).then((value) => value.rows[0].value),
    }));
    expect(result).toEqual({ enrollment: [], device: [], authenticated: false });
  });
});
