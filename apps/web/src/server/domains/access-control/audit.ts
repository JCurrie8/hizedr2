import { withUserContext } from "@hized/db";
import type { PoolClient } from "@neondatabase/serverless";

export interface AuditEvent {
  /** null only for a genuinely platform-level event (requires the actor to be a platform admin). */
  tenantId: string | null;
  actorUserId: string;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

/** Inserts an audit event on the caller's existing transaction. */
export async function insertAuditLog(client: PoolClient, event: AuditEvent): Promise<void> {
  await client.query(
    `insert into public.audit_log
      (tenant_id, actor_user_id, action, target_type, target_id, metadata, ip_address, user_agent)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      event.tenantId,
      event.actorUserId,
      event.action,
      event.targetType ?? null,
      event.targetId ?? null,
      JSON.stringify(event.metadata ?? {}),
      event.ipAddress ?? null,
      event.userAgent ?? null,
    ],
  );
}

/**
 * Writes one immutable audit_log row. Each call is its own narrow
 * transaction, scoped only to this insert — including for cross-tenant
 * denial events, where tenantId is deliberately the tenant the actor was
 * DENIED access to, not one they're an active member of. That's safe:
 * this function only ever runs the one INSERT statement below, never
 * arbitrary caller-supplied SQL, so setting that tenant context here
 * doesn't grant the actor any actual access to the denied tenant's data.
 */
export async function writeAuditLog(event: AuditEvent): Promise<void> {
  await withUserContext({ userId: event.actorUserId, tenantId: event.tenantId ?? undefined }, (c) =>
    insertAuditLog(c, event),
  );
}
