# Activ8 onboarding runbook

This is the first real-customer proof of Hized's shared product path. It must not create an Activ8-only code branch, tenant schema or credential handling exception.

## 1. Confirm source inventory and outcomes

- List the Pulse decisions/KPIs Activ8 needs first, then work backwards to the smallest useful Salesforce objects, Excel/CSV files and stable keys.
- Record source owner, business meaning, expected cadence, approximate row count, retention need and data sensitivity for each source.
- Keep independent feeds independent until a governed KPI actually requires reconciliation. Cross-source client-specific matching is scoped as Hized-managed Custom ETL.

## 2. Salesforce connection

1. In Salesforce, create a dedicated API-only integration user and client-credentials application. Grant only the objects and fields required for the first agreed outcomes.
2. A Hized Company Admin opens **Settings > Connect**, enters the Salesforce My Domain, consumer key and consumer secret, and chooses **Test and save Salesforce**. Do not paste credentials into tickets, chat, source control or this runbook.
3. A Company Admin or Analyst opens **Add object pipeline**, discovers the permitted object, selects only needed scalar fields, chooses an initial-history window and refresh cadence, then creates the pipeline.
4. Run **Refresh now** and check the recent-run accepted/quarantined counts before using the dataset in a KPI.
5. Repeat per object. Every object owns its own schedule, lease and high-water mark; one failing object must not stop the others.

Runtime guarantees:

- Salesforce `Id` is the immutable curated upsert key.
- `SystemModstamp` is preferred, with `LastModifiedDate` or `CreatedDate` only when required by available metadata.
- Every incremental run re-reads a 24-hour overlap and advances its checkpoint only after the complete SQL load commits.
- `queryAll` retains Salesforce-deleted records as governed tombstones.
- The first REST implementation accepts at most 100,000 rows in one extraction and 250 scalar fields. Use a narrower initial-history window if the bootstrap exceeds the bound; Bulk API 2.0 is the next high-volume transport.

## 3. Analyst-delivered Excel and CSV

1. Create a manual file pipeline with the business-facing dataset name.
2. Choose **Replace snapshot** when each delivery is the complete current truth, **Upsert** when a stable response/record key exists, or **Append** only when every delivered row is genuinely new and immutable.
3. For upsert, configure the stable key before repeated deliveries. Microsoft Forms exports should normally use their response ID.
4. Upload CSV/XLSX from **Upload and run**. Snapshot uploads show the current SQL row count and require explicit replacement confirmation.
5. An empty or fully quarantined snapshot is rejected and the existing governed dataset remains live. Review quarantined counts before publishing dependent KPIs.

For workbooks updated throughout the day in SharePoint/OneDrive, use the monitored Microsoft source after its production OAuth configuration is activated. Manual upload remains a controlled fallback, not a second data model.

## 4. Pilot acceptance checkpoint

Before Activ8 data is presented in Pulse or Canvas:

- the source owner confirms row counts and key uniqueness;
- the Analyst records field definitions and marks sensitive projection fields;
- at least one retry/duplicate delivery proves idempotence;
- a deleted or changed Salesforce record is reflected correctly;
- a failed/empty snapshot proves the previous dataset remains intact;
- KPI definitions are approved and linked only to the necessary governed dimensions;
- Company Admin and restricted-user views are checked separately;
- no real credential, raw export or customer row is committed to the repository or demo seed.

## 5. Still required for a dependable live pilot

- Configure and live-test the hourly protected Connect scheduler.
- Complete Microsoft OAuth activation if Activ8 uses monitored SharePoint/Forms workbooks.
- Add Bulk API 2.0 before onboarding any Salesforce object whose required bootstrap cannot fit the bounded REST run.
- Build the operational incident/email delivery slice so failures, stale sources and recovery are proactively sent rather than visible only in Connect.
- Complete the first Activ8 governed datasets/KPIs and role-scoped Pulse views; successful ingestion alone is not the customer outcome.
