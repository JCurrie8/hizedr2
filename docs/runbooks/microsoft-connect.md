# Microsoft Connect setup

Hized uses one multi-tenant Microsoft Entra application for delegated SharePoint Online and OneDrive for Business access. The running application never receives a user's Microsoft password. It stores Microsoft refresh tokens as AES-256-GCM ciphertext bound to the Hized tenant and connector; the encryption key stays in the deployment secret store.

## Entra application

1. Create an app registration that supports **accounts in any organizational directory**.
2. Add the production Web redirect URI `https://hized.app/api/connect/microsoft/callback`. The value must exactly match `MICROSOFT_REDIRECT_URI`; preview URLs need their own explicitly registered redirect URI and environment-scoped configuration.
3. Create a client secret and record it directly in the deployment secret store.
4. Add delegated Microsoft Graph permissions `User.Read`, `Files.Read.All` and `Sites.Read.All`. Hized also requests the OAuth `offline_access` scope so scheduled synchronization can refresh access without the user being present. Customer Entra policy may require an administrator to grant consent.
5. Do not add application-wide Graph permissions for this flow. The initial adapter acts as the connected user and Hized additionally restricts ingestion to the workbook selected in the tenant-scoped connector.

## Runtime variables

Set these independently in each Vercel environment that has its own database:

- `MICROSOFT_CLIENT_ID`
- `MICROSOFT_CLIENT_SECRET`
- `MICROSOFT_REDIRECT_URI`
- `CONNECTOR_ENCRYPTION_KEY` — base64 encoding of exactly 32 random bytes
- `CRON_SECRET` — at least 32 random characters, shared only with the production scheduler

The production platform variables use the canonical domain:

- `BETTER_AUTH_URL=https://hized.app`
- `COOKIE_DOMAIN=.hized.app`
- `MICROSOFT_REDIRECT_URI=https://hized.app/api/connect/microsoft/callback`

Generate a new encryption key with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Never commit the output. Do not replace an environment's encryption key after connectors exist until a credential re-encryption procedure is available; existing ciphertext is intentionally unreadable under a different key.

Generate a separate cron secret with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`. Set that same value as Vercel `CRON_SECRET` and the GitHub Actions repository secret `PRODUCTION_CRON_SECRET`. The protected production endpoint rejects requests when `CRON_SECRET` is absent or shorter than 32 characters. The scheduled workflow invokes it hourly at minute 17; the application claims only pipelines whose configured interval is due. This avoids depending on Vercel's sub-daily Cron feature, which is plan-dependent. Database leases suppress overlaps, and a job can advance its cursor only when its lease and starting delta link still match.

## Current operating flow

1. A company admin or analyst opens Hized Connect and selects **Connect Microsoft**.
2. After Microsoft authorization, the operator chooses SharePoint Online or OneDrive for Business and supplies a CSV/XLSX path. SharePoint paths are relative to the site's default Documents library.
3. For a cumulative Forms workbook, choose **Upsert** and enter the stable response-key column exactly as it appears in the sheet.
4. **Sync now** takes an initial Graph delta cursor before downloading the current workbook, hashes and stores the immutable source revision in R2, runs the common parser/load path, and commits the delta cursor only after a successful load.

The current UI monitors one workbook per Microsoft connection. Multiple connections can be created for companies with several workbooks. **Sync now** works on demand; once migration 0017 and both cron secrets are live, an hourly GitHub Actions trigger claims due work with a ten-minute database lease and each pipeline's configured hourly-to-daily interval. Webhook prompts, folder discovery and non-default SharePoint library browsing remain follow-on work; none changes the stored drive/item ID or final-checkpoint contract.
