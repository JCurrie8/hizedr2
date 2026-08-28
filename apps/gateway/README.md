# Hized Private SQL Gateway

Outbound-only Windows worker for a private SQL Server or Azure SQL source. It polls Hized over HTTPS 443, executes only the shared bounded SQL-analysis contract, and returns semantic result rows. It does not listen on a port, open a firewall rule, accept Remote Desktop credentials, or upload its SQL login.

## Build

From the Hized repository:

```powershell
pnpm --filter @hized/gateway build
```

Copy the complete contents of `apps/gateway/dist` to the approved Windows Server through the customer's normal administration channel. Keep all generated `.js` files together because the compiled worker can include runtime chunks. Node.js 20 or newer is required on that host.

## Install

1. In Hized, open **Settings > Private SQL gateways** and create a 15-minute enrolment token.
2. On the Windows Server, open an elevated PowerShell prompt in the copied folder.
3. Run `./install.ps1 -Database "DatabaseName" -SqlServer "localhost"`.
4. Paste the enrolment token and enter a dedicated SQL-authenticated read-only login when prompted.
5. Confirm the Hized gateway inventory shows `active` and a current heartbeat.

TLS certificate validation is on by default. `-TrustServerCertificate` is an explicit customer-IT exception for a private SQL instance without a trusted certificate; prefer installing a valid SQL Server certificate.

The installer encrypts the device token and SQL credential with Windows DPAPI (LocalMachine), restricts the installation directory to SYSTEM and local Administrators, and registers an at-startup task under SYSTEM. Revoking the gateway in Hized invalidates its device token and disables the associated connection.
