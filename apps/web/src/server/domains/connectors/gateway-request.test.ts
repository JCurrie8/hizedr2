import { describe, expect, it } from "vitest";
import { readBoundedGatewayJson } from "./gateway-request";

describe("bounded gateway request parsing", () => {
  it("accepts JSON within the byte limit", async () => {
    const request = new Request("https://hized.app/api/gateway/enrol", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ protocolVersion: 1 }),
    });
    await expect(readBoundedGatewayJson(request, 1_000)).resolves.toEqual({ protocolVersion: 1 });
  });

  it("rejects a streamed body beyond the byte limit", async () => {
    const request = new Request("https://hized.app/api/gateway/jobs/job/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: "x".repeat(1_000) }),
    });
    await expect(readBoundedGatewayJson(request, 100)).rejects.toThrow(/too large/i);
  });
});
