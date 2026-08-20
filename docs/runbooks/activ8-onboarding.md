# Activ8 onboarding runbook

This is the first real-customer proof of Hized's shared product path. It must not create an Activ8-only code branch, tenant schema or credential handling exception.

## 1. Confirm source inventory and outcomes

- List the Pulse decisions/KPIs Activ8 needs first, then work backwards to the smallest useful Salesforce objects, Excel/CSV files and stable keys.
- Record source owner, business meaning, expected cadence, approximate row count, retention need and data sensitivity for each source.
- Keep independent feeds independent until a governed KPI actually requires reconciliation. Cross-source client-specific matching is scoped as Hized-managed Custom ETL.

## 2. Existing SQL Server connection

Activ8's existing Salesforce-to-SQL process can remain the upstream production feed for the first onboarding. Hized should read only the smallest set of curated SQL tables/views needed for agreed Pulse outcomes. This proves the shared SQL Server connector and avoids forcing a risky source-system cutover during the pilot.

1. Confirm whether the SQL Server/Azure SQL endpoint is publicly reachable with a valid TLS certificate or is private/on-premises behind a VPN. Never expose port 1433 solely for Hized. A private endpoint requires the planned outbound Hized gateway before live activation.
2. Create a dedicated SQL login limited to `SELECT` on explicitly approved schemas, tables and views. Do not use `db_owner`, `db_datawriter`, a personal login or the application's existing ETL writer account.
3. A Hized Company Admin opens **Settings > Connect**, enters the server hostname, port, database and dedicated read-only credentials, then chooses **Test and save SQL connection**. Credentials stay encrypted and are never shown again.
4. A Company Admin or Analyst opens the connection, browses the permitted catalogue, selects only needed scalar fields and chooses either **Replace snapshot** or **Watermark upsert**. Upsert requires a stable unique key and supported datetime watermark.
5. Run **Refresh now**, reconcile the extracted/accepted/quarantined counts with Activ8's source owner, then publish only the validated pipeline as a governed dataset.

The first hosted runtime executes generated, bounded reads only: up to 100,000 rows and 250 fields per extract. It does not accept arbitrary SQL. A watermark run re-reads a 24-hour overlap and commits the checkpoint only after the complete Hized load succeeds. It cannot infer hard-deleted source rows, so use a full snapshot, an approved soft-delete/change-tracking field or scoped Custom ETL where deletion fidelity matters. Manual refresh is available first; scheduled SQL polling and the private-network gateway remain delivery follow-ons.

## 3. Direct Salesforce connection

1. In Salesforce, create a dedicated API-only integration user and client-credentials application. Grant only the objects and fields required for the first agreed outcomes.
2. A Hized Company Admin opens **Settings > Connect**, enters the Salesforce My Domain, consumer key and consumer secret, and chooses **Test and save Salesforce**. Do not paste credentials into tickets, chat, source control or this runbook.
3. A Company Admin or Analyst opens **Add object pipeline**, discovers the permitted object, selects only needed scalar fields, chooses an initial-history window and refresh cadence, then creates the pipeline.
4. Run **Refresh now** and check the recent-run accepted/quarantined counts before using the dataset in a KPI.
5. Repeat per object. Every object owns its own schedule, lease and high-water mark; one failing object must not stop the others.

For the Activ8 pilot, direct Salesforce is a reconciliation or later replacement route while the existing SQL warehouse is authoritative. Do not publish both routes into the same governed production dataset. A deliberate cutover must reconcile row counts, keys, watermark coverage and deletion behaviour before changing the declared source of truth.

Runtime guarantees:

- Salesforce `Id` is the immutable curated upsert key.
- `SystemModstamp` is preferred, with `LastModifiedDate` or `CreatedDate` only when required by available metadata.
- Every incremental run re-reads a 24-hour overlap and advances its checkpoint only after the complete SQL load commits.
- `queryAll` retains Salesforce-deleted records as governed tombstones.
- The first REST implementation accepts at most 100,000 rows in one extraction and 250 scalar fields. Use a narrower initial-history window if the bootstrap exceeds the bound; Bulk API 2.0 is the next high-volume transport.

## 4. Analyst-delivered Excel and CSV

1. Create a manual file pipeline with the business-facing dataset name.
2. Choose **Replace snapshot** when each delivery is the complete current truth, **Upsert** when a stable response/record key exists, or **Append** only when every delivered row is genuinely new and immutable.
3. For upsert, configure the stable key before repeated deliveries. Microsoft Forms exports should normally use their response ID.
4. Upload CSV/XLSX from **Upload and run**. Snapshot uploads show the current SQL row count and require explicit replacement confirmation.
5. An empty or fully quarantined snapshot is rejected and the existing governed dataset remains live. Review quarantined counts before publishing dependent KPIs.

For workbooks updated throughout the day in SharePoint/OneDrive, use the monitored Microsoft source after its production OAuth configuration is activated. Manual upload remains a controlled fallback, not a second data model.

## 5. Pilot acceptance checkpoint

Before Activ8 data is presented in Pulse or Canvas:

- the source owner confirms row counts and key uniqueness;
- the Analyst records field definitions and marks sensitive projection fields;
- at least one retry/duplicate delivery proves idempotence;
- a deleted or changed Salesforce record is reflected correctly;
- SQL credentials are demonstrably read-only and the agreed tables/views, keys, watermark and hard-delete behaviour are recorded;
- each governed dataset has one declared production source of truth, with no duplicate SQL and direct-Salesforce load;
- a failed/empty snapshot proves the previous dataset remains intact;
- KPI definitions are approved and linked only to the necessary governed dimensions;
- Company Admin and restricted-user views are checked separately;
- no real credential, raw export or customer row is committed to the repository or demo seed.

## 6. Still required for a dependable live pilot

- Configure and live-test the hourly protected Connect scheduler.
- If Activ8 SQL is private/on-premises, deploy and verify the outbound Hized gateway; never solve reachability by exposing the database port.
- Complete Microsoft OAuth activation if Activ8 uses monitored SharePoint/Forms workbooks.
- Add Bulk API 2.0 before onboarding any Salesforce object whose required bootstrap cannot fit the bounded REST run.
- Build the operational incident/email delivery slice so failures, stale sources and recovery are proactively sent rather than visible only in Connect.
- Complete the first Activ8 governed datasets/KPIs and role-scoped Pulse views; successful ingestion alone is not the customer outcome.
