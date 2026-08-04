#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { Pool } from "@neondatabase/serverless";
import { DEMO_SEED_VERSION, DEMO_VALID_FROM, demoTenants } from "./demo-data.mjs";

function readOption(name) {
  const exact = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const hasFlag = (name) => process.argv.includes(name);

function printPlan(target) {
  console.log(`Demo seed ${DEMO_SEED_VERSION} (${target ?? "target not selected"})`);
  for (const tenant of demoTenants) {
    const counts = tenant.nodes.reduce((result, node) => {
      result[node.type] = (result[node.type] ?? 0) + 1;
      return result;
    }, {});
    console.log(
      `- ${tenant.name} [${tenant.slug}]: ${tenant.nodes.length} nodes, ${tenant.datasets.length} datasets, ${tenant.kpis.length} KPIs, ${tenant.views.length} views`,
      counts,
    );
  }
}

function requireSafeTarget() {
  const target = readOption("--target");
  if (!target || !["development", "preview", "production"].includes(target)) {
    throw new Error("Choose --target development, preview, or production (or use --dry-run)." );
  }
  if (target === "production" && !hasFlag("--confirm-production")) {
    throw new Error("Production seeding requires the explicit --confirm-production flag.");
  }
  return target;
}

async function upsertTenant(client, tenant, target) {
  const { rows: [row] } = await client.query(
    `insert into public.tenants
       (id, slug, name, timezone, feature_flags)
     values ($1, $2, $3, $4, jsonb_build_object('demoSeed', $5::text, 'demoTarget', $6::text))
     on conflict (id) do update set
       name = excluded.name,
       timezone = excluded.timezone,
       feature_flags = public.tenants.feature_flags || excluded.feature_flags,
       updated_at = now()
     returning id, slug`,
    [tenant.id, tenant.slug, tenant.name, tenant.timezone, DEMO_SEED_VERSION, target],
  );
  if (row.slug !== tenant.slug) {
    throw new Error(`Stable demo tenant ID ${tenant.id} is already used by slug ${row.slug}.`);
  }

  const principal = tenant.seedPrincipal;
  await client.query(
    `insert into "user" (id, name, email, "emailVerified") values ($1, $2, $3, true)
     on conflict (id) do update set name = excluded.name, email = excluded.email, "updatedAt" = now()`,
    [principal.authUserId, principal.name, principal.email],
  );
  await client.query(
    `insert into public.profiles (id, auth_user_id, full_name) values ($1, $2, $3)
     on conflict (id) do update set full_name = excluded.full_name, updated_at = now()`,
    [principal.profileId, principal.authUserId, principal.name],
  );
  await client.query(
    `insert into public.tenant_memberships (id, tenant_id, user_id, role, status)
     values ($1, $2, $3, 'company_admin', 'active')
     on conflict (id) do update set role = 'company_admin', status = 'active', updated_at = now()`,
    [principal.membershipId, tenant.id, principal.profileId],
  );

  for (const node of tenant.nodes) {
    await client.query(
      `insert into public.org_nodes (id, tenant_id, node_type, code)
       values ($1, $2, $3, $4)
       on conflict (id) do update set node_type = excluded.node_type, code = excluded.code`,
      [node.id, tenant.id, node.type, `DEMO-${node.key.toUpperCase()}`],
    );

    const { rows: versions } = await client.query(
      `select id, valid_to from public.org_node_versions
       where org_node_id = $1 and (id = $2 or valid_to is null)`,
      [node.id, node.versionId],
    );
    const unexpectedCurrent = versions.find((version) => version.valid_to === null && version.id !== node.versionId);
    if (unexpectedCurrent) {
      throw new Error(`${tenant.slug}/${node.key} was edited after seeding; refusing to overwrite its history.`);
    }
    const seededVersion = versions.find((version) => version.id === node.versionId);
    if (seededVersion?.valid_to) {
      throw new Error(`${tenant.slug}/${node.key} was deactivated after seeding; refusing to reopen it.`);
    }

    await client.query(
      `insert into public.org_node_versions
         (id, org_node_id, tenant_id, parent_id, name, path, valid_from)
       values ($1, $2, $3, $4, $5, $6::ltree, $7)
       on conflict (id) do update set
         parent_id = excluded.parent_id,
         name = excluded.name,
         path = excluded.path`,
      [node.versionId, node.id, tenant.id, node.parentId, node.name, node.path, DEMO_VALID_FROM],
    );
  }

  for (const dataset of tenant.datasets) {
    await client.query(
      `insert into public.governed_datasets
         (id, tenant_id, dataset_key, name, subject_area, status, refresh_cadence,
          expected_latency, last_refreshed_at, created_by, updated_by)
       values ($1, $2, $3, $4, $5, 'published', $6, $7::interval,
               now() - $8::interval, $9, $9)
       on conflict (id) do nothing`,
      [
        dataset.id,
        tenant.id,
        dataset.key,
        dataset.name,
        dataset.subjectArea,
        dataset.refreshCadence,
        dataset.expectedLatency,
        dataset.sourceAge,
        tenant.seedPrincipal.profileId,
      ],
    );
  }

  const datasetsById = new Map(tenant.datasets.map((dataset) => [dataset.id, dataset]));
  for (const kpi of tenant.kpis) {
    const dataset = datasetsById.get(kpi.datasetId);
    await client.query(
      `insert into public.kpi_definitions
         (id, tenant_id, dataset_id, kpi_key, version_number, name, definition,
          business_purpose, formula_reference, owner_name, reviewer_name, unit, decimal_places,
          favourable_direction, aggregation, refresh_cadence, thresholds,
          valid_from, approval_status, approved_by, approved_at, created_by)
       values ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, $10, $11, $12,
               $13, $14, $15, $16::jsonb, $17, 'approved', $18, now(), $18)
       on conflict (id) do nothing`,
      [
        kpi.id,
        tenant.id,
        kpi.datasetId,
        kpi.key,
        kpi.name,
        kpi.definition,
        kpi.businessPurpose,
        kpi.formulaReference,
        kpi.ownerName,
        kpi.reviewerName,
        kpi.unit,
        kpi.decimalPlaces,
        kpi.favourableDirection,
        kpi.aggregation,
        dataset.refreshCadence,
        JSON.stringify(kpi.thresholds),
        DEMO_VALID_FROM,
        tenant.seedPrincipal.profileId,
      ],
    );

    for (const value of kpi.values) {
      await client.query(
        `insert into public.kpi_values
           (id, tenant_id, kpi_definition_id, org_node_id, period_start, period_end,
            actual_value, target_value, prior_period_value, numerator_value,
            denominator_value, source_refreshed_at, calculated_by)
         values ($1, $2, $3, $4, current_date - 7, current_date, $5, $6, $7,
                 $8, $9, now() - $10::interval, $11)
         on conflict (id) do nothing`,
        [
          value.id,
          tenant.id,
          kpi.id,
          value.orgNodeId,
          value.actual,
          value.target,
          value.prior,
          value.numerator ?? null,
          value.denominator ?? null,
          dataset.sourceAge,
          tenant.seedPrincipal.profileId,
        ],
      );
    }
  }

  for (const view of tenant.views) {
    await client.query(
      `insert into public.analytics_views
         (id, tenant_id, surface, name, description, owner_user_id, visibility,
          status, is_default, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $6, $6)
       on conflict (id) do update set
         name = excluded.name, description = excluded.description,
         visibility = excluded.visibility, status = excluded.status,
         is_default = excluded.is_default, updated_by = excluded.updated_by,
         updated_at = now()`,
      [view.id, tenant.id, view.surface, view.name, view.description, principal.profileId, view.visibility, view.status, view.isDefault],
    );
    for (const widget of view.widgets) {
      await client.query(
        `insert into public.analytics_widgets
           (id, tenant_id, view_id, title, subtitle, visual_type, source_mode,
            position, width, height, created_by, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
         on conflict (id) do update set
           title = excluded.title, subtitle = excluded.subtitle,
           visual_type = excluded.visual_type, source_mode = excluded.source_mode,
           position = excluded.position, width = excluded.width,
           height = excluded.height, updated_by = excluded.updated_by,
           updated_at = now()`,
        [widget.id, tenant.id, view.id, widget.title, widget.subtitle, widget.visualType, widget.sourceMode, widget.position, widget.width, widget.height, principal.profileId],
      );
      await client.query("delete from public.analytics_widget_metrics where tenant_id = $1 and widget_id = $2", [tenant.id, widget.id]);
      if (widget.metricIds.length) {
        await client.query(
          `insert into public.analytics_widget_metrics
             (tenant_id, widget_id, kpi_definition_id, position)
           select $1, $2, metric_id, ordinal - 1
           from unnest($3::uuid[]) with ordinality as selected(metric_id, ordinal)`,
          [tenant.id, widget.id, widget.metricIds],
        );
      }
    }
  }

  await client.query(
    `insert into public.audit_log
       (tenant_id, actor_user_id, action, target_type, target_id, metadata)
     values ($1, $2, 'demo.seeded', 'tenant', $5,
       jsonb_build_object('seedVersion', $3::text, 'target', $4::text,
                          'datasets', $6::integer, 'kpis', $7::integer))`,
    [tenant.id, principal.profileId, DEMO_SEED_VERSION, target, tenant.id, tenant.datasets.length, tenant.kpis.length],
  );
}

async function createAdminInvitations(client, email, rotateInvites, baseUrl) {
  const links = [];
  for (const tenant of demoTenants) {
    const { rowCount: membershipCount } = await client.query(
      `select 1 from public.tenant_memberships m
       join public.profiles p on p.id = m.user_id
       join "user" u on u.id = p.auth_user_id
       where m.tenant_id = $1 and lower(u.email) = lower($2) and m.status = 'active'`,
      [tenant.id, email],
    );
    if (membershipCount) {
      links.push({ tenant: tenant.slug, status: "already a member" });
      continue;
    }

    const pending = await client.query(
      `select id from public.invitations
       where tenant_id = $1 and lower(email::text) = lower($2) and status = 'pending' and expires_at > now()`,
      [tenant.id, email],
    );
    if (pending.rowCount && !rotateInvites) {
      links.push({ tenant: tenant.slug, status: "pending invite exists; use --rotate-invites for a new link" });
      continue;
    }
    if (pending.rowCount) {
      await client.query(
        "update public.invitations set status = 'revoked' where id = any($1::uuid[])",
        [pending.rows.map((row) => row.id)],
      );
    }

    const rawToken = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    await client.query(
      `insert into public.invitations (tenant_id, email, role, invited_by, token_hash)
       values ($1, $2, 'company_admin', $3, $4)`,
      [tenant.id, email, tenant.seedPrincipal.profileId, tokenHash],
    );
    links.push({ tenant: tenant.slug, status: "created", url: `${baseUrl}/invite/${rawToken}` });
  }
  return links;
}

async function main() {
  if (hasFlag("--dry-run")) {
    printPlan(readOption("--target"));
    return;
  }

  const target = requireSafeTarget();
  const connectionString = process.env.MIGRATIONS_DATABASE_URL;
  if (!connectionString) throw new Error("MIGRATIONS_DATABASE_URL is required; DATABASE_URL is intentionally not accepted.");
  const adminEmail = readOption("--admin-email");
  const baseUrl = (readOption("--base-url") ?? process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/$/, "");
  if (adminEmail && !/^\S+@\S+\.\S+$/.test(adminEmail)) throw new Error("--admin-email must be a valid email address.");

  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    const { rows: [identity] } = await client.query("select current_database() as database, current_user as role");
    if (identity.role === "app_user") throw new Error("Demo seeding requires the migration owner, not app_user.");
    console.log(`Seeding ${target} database ${identity.database} as ${identity.role}.`);
    await client.query("begin");
    for (const tenant of demoTenants) await upsertTenant(client, tenant, target);
    const invitations = adminEmail
      ? await createAdminInvitations(client, adminEmail, hasFlag("--rotate-invites"), baseUrl)
      : [];
    if (hasFlag("--rollback")) {
      await client.query("rollback");
      console.log("Validation transaction rolled back; no demo records were persisted.");
    } else {
      await client.query("commit");
    }
    printPlan(target);
    if (adminEmail) console.log("Administrator invitations:", invitations);
    else console.log("No real login was created. Pass --admin-email to create token-bound administrator invitations.");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
