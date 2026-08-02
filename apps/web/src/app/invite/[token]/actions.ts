"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { dbPool } from "@/server/db-pool";
import { auth } from "@/server/domains/identity/auth";
import { acceptInvitationByToken } from "@/server/domains/identity/invitations";

export async function acceptExistingInviteAction(rawToken: string): Promise<void> {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) throw new Error("Sign in before accepting this invitation.");

  const client = await dbPool.connect();
  try {
    await acceptInvitationByToken(client, { authUserId: session.user.id, rawToken });
  } finally {
    client.release();
  }

  redirect("/organisations");
}
