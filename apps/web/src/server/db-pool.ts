import { Pool } from "@neondatabase/serverless";

/**
 * Shared app_user connection pool for reads that don't need
 * withUserContext()'s transaction/session-variable wrapper — i.e. calls
 * into SECURITY DEFINER functions that bypass RLS on their own
 * (get_profile_for_auth_user, get_membership_for_slug,
 * find_invitation_preview, etc.). One pool per process, not one per
 * call site.
 */
export const dbPool = new Pool({ connectionString: process.env.DATABASE_URL });
