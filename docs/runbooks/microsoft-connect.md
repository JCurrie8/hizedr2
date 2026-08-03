# Microsoft Connect setup

Hized uses one multi-tenant Microsoft Entra application for delegated SharePoint Online and OneDrive for Business access. The running application never receives a user's Microsoft password. It stores Microsoft refresh tokens as AES-256-GCM ciphertext bound to the Hized tenant and connector; the encryption key stays in the deployment secret store.

## Entra application

1. Create an app registration that supports **accounts in any organizational directory**.
2. Add a Web redirect URI using the stable Hized callback, for example `https://hized-platform.vercel.app/api/connect/microsoft/callback` until the canonical production domain is live. The value must exactly match `MICROSOFT_REDIRECT_URI`.
3. Create a client secret and record it directly in the deployment secret store.
4. Add delegated Microsoft Graph permissions `User.Read`, `Files.Read.All` and `Sites.Read.All`. Hized also requests the OAuth `offline_access` scope so scheduled synchronization can refresh access without the user being present. Customer Entra policy may require an administrator to grant consent.
5. Do not add application-wide Graph permissions for this flow. The initial adapter acts as the connected user and Hized additionally restricts ingestion to the workbook selected in the tenant-scoped connector.

## Runtime variables

Set these independently in each Vercel environment that has its own database:

- `MICROSOFT_CLIENT_ID`
- `MICROSOFT_CLIENT_SECRET`
- `MICROSOFT_REDIRECT_URI`
- `CONNECTOR_ENCRYPTION_KEY` — base64 encoding of exactly 32 random bytes

Generate a new encryption key with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Never commit the output. Do not replace an environment's encryption key after connectors exist until a credential re-encryption procedure is available; existing ciphertext is intentionally unreadable under a different key.

## Current operating flow

1. A company admin or analyst opens Hized Connect and selects **Connect Microsoft**.
2. After Microsoft authorization, the operator chooses SharePoint Online or OneDrive for Business and supplies a CSV/XLSX path. SharePoint paths are relative to the site's default Documents library.
3. For a cumulative Forms workbook, choose **Upsert** and enter the stable response-key column exactly as it appears in the sheet.
4. **Sync now** takes an initial Graph delta cursor before downloading the current workbook, hashes and stores the immutable source revision in R2, runs the common parser/load path, and commits the delta cursor only after a successful load.

The current UI monitors one workbook per Microsoft connection and runs on demand. Multiple connections can be created for companies with several workbooks. Automated polling, webhook prompts, folder discovery and non-default SharePoint library browsing remain follow-on work; none changes the stored drive/item ID or final-checkpoint contract.
