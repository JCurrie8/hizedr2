import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimDueSharePointSyncs: vi.fn(),
  runClaimedSharePointSync: vi.fn(),
  claimDueSalesforceSyncs: vi.fn(),
  runClaimedSalesforceSync: vi.fn(),
}));

vi.mock("@/server/domains/connectors/sharepoint-scheduler", () => ({
  claimDueSharePointSyncs: mocks.claimDueSharePointSyncs,
  runClaimedSharePointSync: mocks.runClaimedSharePointSync,
}));
vi.mock("@/server/domains/connectors/salesforce-scheduler", () => ({
  claimDueSalesforceSyncs: mocks.claimDueSalesforceSyncs,
  runClaimedSalesforceSync: mocks.runClaimedSalesforceSync,
}));

import { GET } from "./route";

describe("Connect cron endpoint", () => {
  const previousSecret = process.env.CRON_SECRET;

  afterEach(() => {
    vi.clearAllMocks();
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
  });

  it("fails closed before claiming any provider when the secret is absent", async () => {
    delete process.env.CRON_SECRET;
    const response = await GET(new Request("https://hized.example/api/cron/connect", {
      headers: { authorization: "Bearer undefined" },
    }));
    expect(response.status).toBe(401);
    expect(mocks.claimDueSharePointSyncs).not.toHaveBeenCalled();
    expect(mocks.claimDueSalesforceSyncs).not.toHaveBeenCalled();
  });

  it("claims Microsoft and Salesforce work with the exact bearer secret", async () => {
    process.env.CRON_SECRET = "s".repeat(32);
    const microsoft = { tenantId: "t1", connectorId: "m1", pipelineId: "p1", actorUserId: "a1", leaseToken: "l1" };
    const salesforce = { tenantId: "t2", connectorId: "s1", pipelineId: "p2", actorUserId: "a2", leaseToken: "l2" };
    mocks.claimDueSharePointSyncs.mockResolvedValue([microsoft]);
    mocks.claimDueSalesforceSyncs.mockResolvedValue([salesforce]);
    mocks.runClaimedSharePointSync.mockResolvedValue({ outcome: "unchanged" });
    mocks.runClaimedSalesforceSync.mockResolvedValue({ outcome: "loaded" });
    const response = await GET(new Request("https://hized.example/api/cron/connect", {
      headers: { authorization: `Bearer ${"s".repeat(32)}` },
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ claimed: 2, succeeded: 2, failed: 0 });
    expect(mocks.runClaimedSharePointSync).toHaveBeenCalledWith(microsoft);
    expect(mocks.runClaimedSalesforceSync).toHaveBeenCalledWith(salesforce);
  });
});
