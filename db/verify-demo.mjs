#!/usr/bin/env node
import { withUserContext } from "../packages/db/src/index.ts";
import { demoTenants } from "./demo-data.mjs";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required and must use the restricted app_user role.");
  process.exit(1);
}

for (const tenant of demoTenants) {
  const visibleTenants = await withUserContext(
    { userId: tenant.seedPrincipal.profileId },
    async (client) => (await client.query("select id, slug from public.tenants order by slug")).rows,
  );
  if (visibleTenants.length !== 1 || visibleTenants[0].id !== tenant.id) {
    throw new Error(`${tenant.slug} seed principal did not resolve exactly its own tenant.`);
  }

  const visibleNodes = await withUserContext(
    { userId: tenant.seedPrincipal.profileId, tenantId: tenant.id },
    async (client) => (
      await client.query(
        `select n.id, n.tenant_id
         from public.org_nodes n
         join public.org_node_versions v on v.org_node_id = n.id
         where v.valid_to is null`,
      )
    ).rows,
  );
  if (visibleNodes.length !== tenant.nodes.length || visibleNodes.some((node) => node.tenant_id !== tenant.id)) {
    throw new Error(`${tenant.slug} hierarchy did not resolve to its ${tenant.nodes.length} isolated nodes.`);
  }

  const visibleKpis = await withUserContext(
    { userId: tenant.seedPrincipal.profileId, tenantId: tenant.id },
    async (client) => (
      await client.query(
        `select definition.id, definition.tenant_id
         from public.kpi_definitions definition
         where definition.approval_status = 'approved'`,
      )
    ).rows,
  );
  if (visibleKpis.length !== tenant.kpis.length || visibleKpis.some((kpi) => kpi.tenant_id !== tenant.id)) {
    throw new Error(`${tenant.slug} KPI catalogue did not resolve to its ${tenant.kpis.length} isolated definitions.`);
  }

  const other = demoTenants.find((candidate) => candidate.id !== tenant.id);
  const crossTenantNodes = await withUserContext(
    { userId: tenant.seedPrincipal.profileId, tenantId: other.id },
    async (client) => (await client.query("select id from public.org_nodes where tenant_id = $1", [other.id])).rows,
  );
  if (crossTenantNodes.length !== 0) {
    throw new Error(`${tenant.slug} seed principal can read ${other.slug} hierarchy rows.`);
  }

  console.log(`ok ${tenant.slug}: one tenant, ${visibleNodes.length} own nodes, ${visibleKpis.length} own KPIs, zero cross-tenant nodes`);
}
