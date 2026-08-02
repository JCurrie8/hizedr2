/**
 * Shared TS types/zod schemas for cross-domain contracts (Tenant, OrgNode,
 * Membership, AuditEvent, ...). Populated as each domain lands — kept as a
 * thin package so app + worker code can share validated shapes without
 * duplicating them.
 */

/** Mirrors the public.app_role Postgres enum (db/migrations/0002_core_schema.sql). */
export type AppRole =
  | "company_admin"
  | "executive"
  | "functional_leader"
  | "manager"
  | "employee"
  | "analyst";

export * from "./org";
export * from "./connect";
