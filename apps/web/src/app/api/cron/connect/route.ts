import { timingSafeEqual } from "node:crypto";
import { claimDueSalesforceSyncs, runClaimedSalesforceSync } from "@/server/domains/connectors/salesforce-scheduler";
import { claimDueSharePointSyncs, runClaimedSharePointSync } from "@/server/domains/connectors/sharepoint-scheduler";
import { claimDueSqlDestinationSyncs, runClaimedSqlDestinationSync } from "@/server/domains/connectors/sql-server-destination-scheduler";

export const maxDuration = 300;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 32) return false;
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
}

export async function GET(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const [microsoftJobs, salesforceJobs, sqlDestinationJobs] = await Promise.all([
    claimDueSharePointSyncs(3),
    claimDueSalesforceSyncs(3),
    claimDueSqlDestinationSyncs(3),
  ]);
  const jobs = [
    ...microsoftJobs.map((job) => ({ provider: "microsoft" as const, job })),
    ...salesforceJobs.map((job) => ({ provider: "salesforce" as const, job })),
    ...sqlDestinationJobs.map((job) => ({ provider: "sql_destination" as const, job })),
  ];
  const results = await Promise.allSettled(jobs.map(({ provider, job }) => {
    if (provider === "microsoft") return runClaimedSharePointSync(job);
    if (provider === "salesforce") return runClaimedSalesforceSync(job);
    return runClaimedSqlDestinationSync(job);
  }));
  return Response.json({
    claimed: jobs.length,
    succeeded: results.filter((result) => result.status === "fulfilled").length,
    failed: results.filter((result) => result.status === "rejected").length,
    outcomes: results.map((result, index) => {
      const provider = jobs[index]?.provider;
      const outcome = result.status === "rejected"
        ? "failed"
        : provider === "sql_destination"
          ? (result.value as { duplicate: boolean }).duplicate ? "unchanged" : "loaded"
          : (result.value as { outcome: string }).outcome;
      return { provider, connectorId: jobs[index]?.job.connectorId, outcome };
    }),
  });
}
