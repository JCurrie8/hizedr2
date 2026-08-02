import { z } from "zod";

export const ConnectorTypeSchema = z.enum([
  "file_upload",
  "sharepoint",
  "sql_server",
  "azure_sql",
  "salesforce",
  "zendesk",
  "hubspot",
  "dynamics365",
  "rest_api",
]);
export type ConnectorType = z.infer<typeof ConnectorTypeSchema>;

export const CheckpointStrategySchema = z.enum([
  "full_refresh",
  "modified_since",
  "cursor",
  "delta",
]);
export type CheckpointStrategy = z.infer<typeof CheckpointStrategySchema>;

const salesforceObjectName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const salesforceFieldName = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

export const SalesforceObjectConfigSchema = z
  .object({
    object: z.string().regex(salesforceObjectName, "Invalid Salesforce object API name"),
    fields: z.array(z.string().regex(salesforceFieldName, "Invalid Salesforce field API name")).min(1),
    primaryKey: z.literal("Id").default("Id"),
    modifiedField: z.string().regex(salesforceFieldName).default("SystemModstamp"),
    includeDeleted: z.boolean().default(true),
    initialLookbackSeconds: z.number().int().positive().default(86_400),
    overlapSeconds: z.number().int().nonnegative().default(86_400),
    bulkThreshold: z.number().int().positive().default(2_000),
  })
  .superRefine((config, context) => {
    for (const requiredField of [config.primaryKey, config.modifiedField]) {
      if (!config.fields.includes(requiredField)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fields"],
          message: `fields must include ${requiredField}`,
        });
      }
    }
  });
export type SalesforceObjectConfig = z.infer<typeof SalesforceObjectConfigSchema>;

export const ZendeskResourceConfigSchema = z.object({
  resource: z.enum(["tickets", "ticket_events", "users", "organizations"]),
  initialLookbackSeconds: z.number().int().positive().default(86_400),
  perPage: z.number().int().min(1).max(1_000).default(1_000),
});
export type ZendeskResourceConfig = z.infer<typeof ZendeskResourceConfigSchema>;

export interface ExtractPage<TRecord, TCursor> {
  records: TRecord[];
  nextCursor: TCursor | null;
  endOfStream: boolean;
}

export interface ModifiedSinceCheckpoint {
  strategy: "modified_since";
  committedThroughAt: string;
}

export interface CursorCheckpoint<TCursor = unknown> {
  strategy: "cursor";
  cursor: TCursor;
}
