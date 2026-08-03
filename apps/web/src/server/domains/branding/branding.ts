import type { PoolClient } from "@neondatabase/serverless";

export const BRANDING_DEFAULTS = {
  primaryColor: "#0F2A43",
  accentColor: "#0E7C80",
  typography: "hized",
} as const;

export const BRANDING_TYPOGRAPHIES = ["hized", "clean", "geometric"] as const;
export type BrandingTypography = (typeof BRANDING_TYPOGRAPHIES)[number];

export interface BrandingTheme {
  logoObjectKey: string | null;
  logoContentType: "image/png" | "image/webp" | null;
  primaryColor: string;
  accentColor: string;
  typography: BrandingTypography;
  changedAt: string | null;
}

interface BrandingRow {
  logo_object_key: string | null;
  logo_content_type: "image/png" | "image/webp" | null;
  primary_color: string;
  accent_color: string;
  typography: BrandingTypography;
  changed_at: Date | string;
}

function mapBranding(row: BrandingRow | undefined): BrandingTheme {
  if (!row) {
    return {
      logoObjectKey: null,
      logoContentType: null,
      primaryColor: BRANDING_DEFAULTS.primaryColor,
      accentColor: BRANDING_DEFAULTS.accentColor,
      typography: BRANDING_DEFAULTS.typography,
      changedAt: null,
    };
  }
  return {
    logoObjectKey: row.logo_object_key,
    logoContentType: row.logo_content_type,
    primaryColor: row.primary_color.toUpperCase(),
    accentColor: row.accent_color.toUpperCase(),
    typography: row.typography,
    changedAt: new Date(row.changed_at).toISOString(),
  };
}

export function isBrandingTypography(value: string): value is BrandingTypography {
  return BRANDING_TYPOGRAPHIES.includes(value as BrandingTypography);
}

export function normaliseBrandColor(value: string): string {
  const color = value.trim().toUpperCase();
  if (!/^#[0-9A-F]{6}$/.test(color)) throw new Error("Choose a valid six-digit hex colour.");
  return color;
}

function relativeLuminance(color: string): number {
  const channels = [1, 3, 5].map((index) => Number.parseInt(color.slice(index, index + 2), 16) / 255);
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrastRatio(first: string, second: string): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

export function accessibleForeground(background: string): "#FFFFFF" | "#081B2C" {
  const color = normaliseBrandColor(background);
  return contrastRatio(color, "#FFFFFF") >= contrastRatio(color, "#081B2C") ? "#FFFFFF" : "#081B2C";
}

export function validateAccessibleBrandColor(value: string): string {
  const color = normaliseBrandColor(value);
  const foreground = accessibleForeground(color);
  if (contrastRatio(color, foreground) < 4.5) {
    throw new Error("Choose a colour that supports accessible text contrast.");
  }
  return color;
}

export function brandingFontVariables(typography: BrandingTypography): {
  body: string;
  heading: string;
} {
  if (typography === "clean") {
    return { body: "var(--font-inter), system-ui, sans-serif", heading: "var(--font-inter), system-ui, sans-serif" };
  }
  if (typography === "geometric") {
    return {
      body: "var(--font-space-grotesk), var(--font-inter), system-ui, sans-serif",
      heading: "var(--font-space-grotesk), sans-serif",
    };
  }
  return {
    body: "var(--font-inter), system-ui, sans-serif",
    heading: "var(--font-space-grotesk), sans-serif",
  };
}

export async function getPublishedBranding(
  client: PoolClient,
  input: { tenantId: string },
): Promise<BrandingTheme> {
  const { rows } = await client.query<BrandingRow>(
    `select logo_object_key, logo_content_type, primary_color, accent_color, typography,
            published_at as changed_at
     from public.tenant_branding
     where tenant_id = $1`,
    [input.tenantId],
  );
  return mapBranding(rows[0]);
}

export async function getDraftBranding(
  client: PoolClient,
  input: { tenantId: string },
): Promise<BrandingTheme> {
  const { rows } = await client.query<BrandingRow>(
    `select logo_object_key, logo_content_type, primary_color, accent_color, typography,
            updated_at as changed_at
     from public.tenant_branding_drafts
     where tenant_id = $1`,
    [input.tenantId],
  );
  if (rows[0]) return mapBranding(rows[0]);
  return getPublishedBranding(client, input);
}

export async function saveBrandingDraft(
  client: PoolClient,
  input: {
    tenantId: string;
    actorUserId: string;
    logoObjectKey: string | null;
    logoContentType: "image/png" | "image/webp" | null;
    primaryColor: string;
    accentColor: string;
    typography: BrandingTypography;
  },
): Promise<BrandingTheme> {
  const { rows } = await client.query<BrandingRow>(
    `insert into public.tenant_branding_drafts
       (tenant_id, logo_object_key, logo_content_type, primary_color, accent_color,
        typography, updated_by, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, now())
     on conflict (tenant_id) do update set
       logo_object_key = excluded.logo_object_key,
       logo_content_type = excluded.logo_content_type,
       primary_color = excluded.primary_color,
       accent_color = excluded.accent_color,
       typography = excluded.typography,
       updated_by = excluded.updated_by,
       updated_at = now()
     returning logo_object_key, logo_content_type, primary_color, accent_color, typography,
               updated_at as changed_at`,
    [
      input.tenantId,
      input.logoObjectKey,
      input.logoContentType,
      validateAccessibleBrandColor(input.primaryColor),
      validateAccessibleBrandColor(input.accentColor),
      input.typography,
      input.actorUserId,
    ],
  );
  return mapBranding(rows[0]);
}

export async function publishBranding(
  client: PoolClient,
  input: { tenantId: string; actorUserId: string },
): Promise<{ theme: BrandingTheme; previousLogoObjectKey: string | null; changedFields: string[] }> {
  const { rows: draftRows } = await client.query<BrandingRow>(
    `select logo_object_key, logo_content_type, primary_color, accent_color, typography,
            updated_at as changed_at
     from public.tenant_branding_drafts
     where tenant_id = $1
     for update`,
    [input.tenantId],
  );
  if (!draftRows[0]) throw new Error("Save a branding draft before publishing it.");

  const previous = await getPublishedBranding(client, { tenantId: input.tenantId });
  const draft = mapBranding(draftRows[0]);
  const changedFields = (["logoObjectKey", "primaryColor", "accentColor", "typography"] as const)
    .filter((field) => previous[field] !== draft[field]);

  const { rows } = await client.query<BrandingRow>(
    `insert into public.tenant_branding
       (tenant_id, logo_object_key, logo_content_type, primary_color, accent_color,
        typography, published_by, published_at)
     values ($1, $2, $3, $4, $5, $6, $7, now())
     on conflict (tenant_id) do update set
       logo_object_key = excluded.logo_object_key,
       logo_content_type = excluded.logo_content_type,
       primary_color = excluded.primary_color,
       accent_color = excluded.accent_color,
       typography = excluded.typography,
       published_by = excluded.published_by,
       published_at = now()
     returning logo_object_key, logo_content_type, primary_color, accent_color, typography,
               published_at as changed_at`,
    [
      input.tenantId,
      draft.logoObjectKey,
      draft.logoContentType,
      draft.primaryColor,
      draft.accentColor,
      draft.typography,
      input.actorUserId,
    ],
  );
  return { theme: mapBranding(rows[0]), previousLogoObjectKey: previous.logoObjectKey, changedFields };
}

export async function resetBranding(
  client: PoolClient,
  input: { tenantId: string; actorUserId: string },
): Promise<{ removedLogoObjectKeys: string[] }> {
  const published = await getPublishedBranding(client, { tenantId: input.tenantId });
  const draft = await getDraftBranding(client, { tenantId: input.tenantId });
  await saveBrandingDraft(client, {
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    logoObjectKey: null,
    logoContentType: null,
    ...BRANDING_DEFAULTS,
  });
  await client.query(
    `insert into public.tenant_branding
       (tenant_id, primary_color, accent_color, typography, published_by, published_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (tenant_id) do update set
       logo_object_key = null,
       logo_content_type = null,
       primary_color = excluded.primary_color,
       accent_color = excluded.accent_color,
       typography = excluded.typography,
       published_by = excluded.published_by,
       published_at = now()`,
    [
      input.tenantId,
      BRANDING_DEFAULTS.primaryColor,
      BRANDING_DEFAULTS.accentColor,
      BRANDING_DEFAULTS.typography,
      input.actorUserId,
    ],
  );
  return {
    removedLogoObjectKeys: [...new Set([published.logoObjectKey, draft.logoObjectKey].filter((key): key is string => Boolean(key)))],
  };
}
