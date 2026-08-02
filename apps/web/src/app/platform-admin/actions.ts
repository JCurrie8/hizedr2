"use server";

import { revalidatePath } from "next/cache";
import { withUserContext } from "@hized/db";
import { getAuthContextFromRequest } from "@/server/domains/access-control/auth-context";
import { writeAuditLog } from "@/server/domains/access-control/audit";

async function requirePlatformAdmin() {
  const ctx = await getAuthContextFromRequest({ platformAdminRoute: true });
  if (ctx.kind !== "platform_admin") throw new Error("Platform admin access only.");
  return ctx;
}

/** PLATFORM-001: create a tenant without developer database access. */
export async function createTenantAction(formData: FormData) {
  const ctx = await requirePlatformAdmin();

  const name = String(formData.get("name") ?? "").trim();
  const slug = String(formData.get("slug") ?? "").trim().toLowerCase();
  if (!name || !slug) throw new Error("Name and slug are required.");
  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw new Error("Slug can only contain lowercase letters, numbers and hyphens.");
  }

  const tenant = await withUserContext({ userId: ctx.profileId }, (c) =>
    c
      .query("insert into public.tenants (slug, name) values ($1, $2) returning id", [slug, name])
      .then((r) => r.rows[0]),
  );

  await writeAuditLog({
    tenantId: tenant.id,
    actorUserId: ctx.profileId,
    action: "tenant.created",
    targetType: "tenant",
    targetId: tenant.id,
    metadata: { name, slug },
  });

  revalidatePath("/");
}
