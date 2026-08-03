import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withUserContext } from "@hized/db";
import { cleanupFixture, createTenantWithUser, getAdminPool, type TenantFixture } from "@hized/testing";
import { listProductEntitlements, hasProductAccess } from "./entitlements";

describe("tenant product entitlements", () => {
  const owner = getAdminPool();
  let fixture: TenantFixture;

  beforeAll(async () => {
    fixture = await createTenantWithUser(owner, {
      slug: `product-entitlements-${Date.now()}`,
      name: "Product Entitlements Test",
      email: `product-entitlements-${Date.now()}@test.local`,
    });
  });

  afterAll(async () => {
    if (fixture) await cleanupFixture(owner, fixture);
    await owner.end();
  });

  it("seeds explicit access for released products and locks Canvas", async () => {
    await withUserContext({ userId: fixture.profileId, tenantId: fixture.tenantId }, async (client) => {
      await expect(listProductEntitlements(client, { tenantId: fixture.tenantId })).resolves.toEqual([
        { productKey: "canvas", status: "locked" },
        { productKey: "connect", status: "active" },
        { productKey: "pulse", status: "active" },
      ]);
      await expect(hasProductAccess(client, { tenantId: fixture.tenantId, productKey: "pulse" })).resolves.toBe(true);
      await expect(hasProductAccess(client, { tenantId: fixture.tenantId, productKey: "canvas" })).resolves.toBe(false);
    });
  });
});
