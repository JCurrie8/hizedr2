import { afterEach, describe, expect, it, vi } from "vitest";

const { claimDueSharePointSyncs, runClaimedSharePointSync } = vi.hoisted(() => ({
  claimDueSharePointSyncs: vi.fn(),
  runClaimedSharePointSync: vi.fn(),
}));

vi.mock("@/server/domains/connectors/sharepoint-scheduler", () => ({
  claimDueSharePointSyncs,
  runClaimedSharePointSync,
}));

import { GET } from "./route";

describe("SharePoint cron endpoint", () => {
  const previousSecret = process.env.CRON_SECRET;

  afterEach(() => {
    vi.clearAllMocks();
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
  });

  it("fails closed when the cron secret is absent", async () => {
    delete process.env.CRON_SECRET;
    const response = await GET(new Request("https://hized.example/api/cron/sharepoint", {
      headers: { authorization: "Bearer undefined" },
    }));
    expect(response.status).toBe(401);
    expect(claimDueSharePointSyncs).not.toHaveBeenCalled();
  });

  it("claims and runs work only with the exact bearer secret", async () => {
    process.env.CRON_SECRET = "s".repeat(32);
    const job = {
      tenantId: "tenant",
      connectorId: "connector",
      pipelineId: "pipeline",
      actorUserId: "actor",
      leaseToken: "lease",
    };
    claimDueSharePointSyncs.mockResolvedValue([job]);
    runClaimedSharePointSync.mockResolvedValue({ outcome: "unchanged" });
    const response = await GET(new Request("https://hized.example/api/cron/sharepoint", {
      headers: { authorization: `Bearer ${"s".repeat(32)}` },
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    expect(runClaimedSharePointSync).toHaveBeenCalledWith(job);
  });
});
