import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { dbPool } from "@/server/db-pool";
import { auth } from "@/server/domains/identity/auth";
import { findInvitationPreview } from "@/server/domains/identity/invitations";
import { AcceptInviteForm } from "@/components/AcceptInviteForm";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const client = await dbPool.connect();
  let invitation;
  try {
    invitation = await findInvitationPreview(client, token);
  } finally {
    client.release();
  }

  if (!invitation) notFound();
  const session = await auth.api.getSession({ headers: await headers() });

  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="w-full max-w-sm px-8">
        <p className="font-mono text-xs uppercase tracking-[0.16em] text-teal-deep">
          You&apos;re invited
        </p>
        <h1 className="mt-2 font-display text-2xl font-bold text-ink">
          Join {invitation.tenantName}
        </h1>
        <p className="mt-2 text-sm text-muted">
          as {invitation.role.replace("_", " ")} — {invitation.email}
        </p>
        <div className="mt-6">
          <AcceptInviteForm email={invitation.email} token={token} signedInEmail={session?.user.email ?? null} />
        </div>
      </div>
    </div>
  );
}
