import { afterEach, describe, expect, it, vi } from "vitest";
import { collectMicrosoftDriveDelta, seedMicrosoftDriveDelta } from "./microsoft-graph";

describe("Microsoft Graph delta client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reconciles the selected item's last state across multiple pages", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        value: [{ id: "selected", name: "responses.xlsx", file: {}, eTag: "stale" }],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/drives/drive/root/delta?token=page-2",
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        value: [{ id: "selected", deleted: {} }],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/drives/drive/root/delta?token=complete",
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await collectMicrosoftDriveDelta({
      accessToken: "access-token",
      deltaLink: "https://graph.microsoft.com/v1.0/drives/drive/root/delta?token=start",
      selectedItemIds: new Set(["selected"]),
    });

    expect(result.changes).toEqual([{ kind: "delete", driveItemId: "selected" }]);
    expect(result.deltaLink).toContain("token=complete");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({ authorization: "Bearer access-token" });
  });

  it("seeds an empty latest checkpoint before the first workbook download", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      value: [],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/drives/drive/root/delta?token=latest",
    }), { status: 200, headers: { "content-type": "application/json" } })));

    await expect(seedMicrosoftDriveDelta("access-token", "drive/id"))
      .resolves.toContain("token=latest");
  });
});
