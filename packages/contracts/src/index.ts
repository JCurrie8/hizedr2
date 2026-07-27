/**
 * Shared TS types/zod schemas for cross-domain contracts (Tenant, OrgNode,
 * Membership, AuditEvent, ...). Populated as each domain lands — kept as a
 * thin package so app + worker code can share validated shapes without
 * duplicating them.
 */
export {};
