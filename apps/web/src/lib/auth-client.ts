"use client";

import { createAuthClient } from "better-auth/react";
import { twoFactorClient } from "better-auth/client/plugins";

// No baseURL: Better Auth's client defaults to same-origin relative
// requests, which is what we want — each tenant subdomain must talk to
// its own origin's /api/auth, not one fixed hostname (see the tenant
// resolution design in task 6).
export const authClient = createAuthClient({
  plugins: [twoFactorClient()],
});
