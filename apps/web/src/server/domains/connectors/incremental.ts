import {
  SalesforceObjectConfigSchema,
  ZendeskResourceConfigSchema,
  type ModifiedSinceCheckpoint,
  type SalesforceObjectConfig,
  type ZendeskResourceConfig,
} from "@hized/contracts";

export interface ModifiedSinceWindow {
  startInclusive: string;
  endExclusive: string;
}

export function planModifiedSinceWindow(input: {
  now: Date;
  committedThroughAt?: string | null;
  overlapSeconds: number;
  initialLookbackSeconds: number;
}): ModifiedSinceWindow {
  const endMs = input.now.getTime();
  if (!Number.isFinite(endMs)) throw new Error("now must be a valid date");
  if (!Number.isInteger(input.overlapSeconds) || input.overlapSeconds < 0) {
    throw new Error("overlapSeconds must be a non-negative integer");
  }
  if (!Number.isInteger(input.initialLookbackSeconds) || input.initialLookbackSeconds <= 0) {
    throw new Error("initialLookbackSeconds must be a positive integer");
  }

  let startMs = endMs - input.initialLookbackSeconds * 1_000;
  if (input.committedThroughAt) {
    const committedMs = Date.parse(input.committedThroughAt);
    if (!Number.isFinite(committedMs)) throw new Error("committedThroughAt must be an ISO timestamp");
    if (committedMs > endMs) throw new Error("committedThroughAt cannot be in the future");
    startMs = committedMs - input.overlapSeconds * 1_000;
  }

  return {
    startInclusive: new Date(startMs).toISOString(),
    endExclusive: new Date(endMs).toISOString(),
  };
}

export function planSalesforceExtract(input: {
  config: SalesforceObjectConfig;
  now: Date;
  committedThroughAt?: string | null;
}): { config: SalesforceObjectConfig; window: ModifiedSinceWindow; soql: string; useQueryAll: boolean } {
  const config = SalesforceObjectConfigSchema.parse(input.config);
  const window = planModifiedSinceWindow({
    now: input.now,
    committedThroughAt: input.committedThroughAt,
    overlapSeconds: config.overlapSeconds,
    initialLookbackSeconds: config.initialLookbackSeconds,
  });
  const fields = [...new Set(config.fields)];
  const soql = [
    `SELECT ${fields.join(", ")}`,
    `FROM ${config.object}`,
    `WHERE ${config.modifiedField} >= ${window.startInclusive}`,
    `AND ${config.modifiedField} < ${window.endExclusive}`,
    `ORDER BY ${config.modifiedField} ASC, ${config.primaryKey} ASC`,
  ].join(" ");

  return { config, window, soql, useQueryAll: config.includeDeleted };
}

export function salesforceCheckpointAfterSuccess(window: ModifiedSinceWindow): ModifiedSinceCheckpoint {
  return { strategy: "modified_since", committedThroughAt: window.endExclusive };
}

export type ZendeskCursor = { afterCursor: string };

export function planZendeskExtract(input: {
  config: ZendeskResourceConfig;
  now: Date;
  checkpoint?: ZendeskCursor | null;
}): { config: ZendeskResourceConfig; cursor?: string; startTime?: number } {
  const config = ZendeskResourceConfigSchema.parse(input.config);
  if (input.checkpoint) return { config, cursor: input.checkpoint.afterCursor };

  const nowMs = input.now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("now must be a valid date");
  return {
    config,
    startTime: Math.floor((nowMs - config.initialLookbackSeconds * 1_000) / 1_000),
  };
}

export function zendeskCheckpointAfterPage(input: {
  afterCursor: string | null;
  endOfStream: boolean;
}): ZendeskCursor | null {
  if (!input.endOfStream) return null;
  if (!input.afterCursor) throw new Error("Zendesk ended the stream without an after_cursor");
  return { afterCursor: input.afterCursor };
}
