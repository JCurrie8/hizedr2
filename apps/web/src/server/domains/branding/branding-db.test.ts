import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "@neondatabase/serverless";
import { withUserContext } from "@hized/db";
import {
  BRANDING_DEFAULTS,
  getDraftBranding,
  getPublishedBranding,
  publishBranding,
  resetBranding,
  saveBrandingDraft,
} from "./branding";

describe("tenant branding lifecycle", () => {
  const owner = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });
  let tenantId: string;
  let profileId: string;
  let authUserId: string;

  beforeAll(async () => {
    const { rows: [tenant] } = await owner.query(
      "insert into public.tenants (slug, name) values ($1, 'Branding Lifecycle') returning id",
      [`branding-${randomUUID()}`],
    );
    const { rows: [user] } = await owner.query(
      `insert into public."user" (id, name, email, "emailVerified")
       values (gen_random_uuid()::text, 'Brand Admin', $1, true) returning id`,
      [`branding-${randomUUID()}@test.local`],
    );
    const { rows: [profile] } = await owner.query(
      "insert into public.profiles (auth_user_id, full_name) values ($1, 'Brand Admin') returning id",
      [user.id],
    );
    await owner.query(
      "insert into public.tenant_memberships (tenant_id, user_id, role) values ($1, $2, 'company_admin')",
      [tenant.id, profile.id],
    );
    tenantId = tenant.id;
    profileId = profile.id;
    authUserId = user.id;
  });

  afterAll(async () => {
    if (tenantId) await owner.query("delete from public.tenants where id = $1", [tenantId]);
    if (profileId) await owner.query("delete from public.profiles where id = $1", [profileId]);
    if (authUserId) await owner.query(`delete from public."user" where id = $1`, [authUserId]);
    await owner.end();
  });

  it("keeps a draft private until publish and restores defaults on reset", async () => {
    await withUserContext({ userId: profileId, tenantId }, async (client) => {
      expect(await getPublishedBranding(client, { tenantId })).toMatchObject(BRANDING_DEFAULTS);

      await saveBrandingDraft(client, {
        tenantId,
        actorUserId: profileId,
        logoObjectKey: `${tenantId}/branding/drafts/test.webp`,
        logoContentType: "image/webp",
        primaryColor: "#112233",
        accentColor: "#D8B24C",
        typography: "clean",
      });
      expect(await getDraftBranding(client, { tenantId })).toMatchObject({
        primaryColor: "#112233",
        accentColor: "#D8B24C",
        typography: "clean",
      });
      expect(await getPublishedBranding(client, { tenantId })).toMatchObject(BRANDING_DEFAULTS);

      const published = await publishBranding(client, { tenantId, actorUserId: profileId });
      expect(published.changedFields).toEqual(["logoObjectKey", "primaryColor", "accentColor", "typography"]);
      expect(await getPublishedBranding(client, { tenantId })).toMatchObject({
        primaryColor: "#112233",
        accentColor: "#D8B24C",
        typography: "clean",
      });

      const reset = await resetBranding(client, { tenantId, actorUserId: profileId });
      expect(reset.removedLogoObjectKeys).toEqual([`${tenantId}/branding/drafts/test.webp`]);
      expect(await getPublishedBranding(client, { tenantId })).toMatchObject(BRANDING_DEFAULTS);
    });
  });
});
