import { timingSafeEqual } from "node:crypto";
import { claimDueSharePointSyncs, runClaimedSharePointSync } from "@/server/domains/connectors/sharepoint-scheduler";

export const maxDuration = 300;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 32) return false;
  const supplied = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(suppliedBytes, expectedBytes);
}

export async function GET(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const jobs = await claimDueSharePointSyncs(5);
  const results = await Promise.allSettled(jobs.map((job) => runClaimedSharePointSync(job)));
  return Response.json({
    claimed: jobs.length,
    succeeded: results.filter((result) => result.status === "fulfilled").length,
    failed: results.filter((result) => result.status === "rejected").length,
    outcomes: results.map((result, index) => ({
      connectorId: jobs[index]?.connectorId,
      outcome: result.status === "fulfilled" ? result.value.outcome : "failed",
    })),
  });
}
