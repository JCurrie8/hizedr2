import { redirect } from "next/navigation";

/**
 * The proxy routes tenant-subdomain roots directly to /dashboard. This is
 * the apex/fallback entry point: /organisations resolves the signed-in
 * identity, redirects single-tenant users to Pulse, and sends signed-out
 * visitors to /login.
 */
export default function Home() {
  redirect("/organisations");
}
