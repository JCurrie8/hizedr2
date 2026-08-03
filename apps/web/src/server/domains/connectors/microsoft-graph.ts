import {
  assertGraphDeltaUrl,
  planSharePointDeltaPage,
  type GraphDriveDeltaPage,
  type GraphDriveItem,
  type SharePointDeltaChange,
} from "./sharepoint-delta";

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
const MAX_DELTA_PAGES = 1_000;
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;

interface GraphErrorPayload {
  error?: { code?: string; message?: string };
}

export interface MicrosoftAccount {
  id: string;
  displayName: string | null;
  email: string | null;
}

export interface ResolvedMicrosoftWorkbook {
  sourceKind: "sharepoint" | "onedrive";
  siteId: string | null;
  driveId: string;
  driveItemId: string;
  sourceName: string;
  sourcePath: string;
  sourceETag: string | null;
  sourceCTag: string | null;
  sourceModifiedAt: string | null;
  sizeBytes: number | null;
}

async function graphJson<T>(accessToken: string, urlOrPath: string): Promise<T> {
  const url = assertGraphDeltaUrl(urlOrPath.startsWith("http") ? urlOrPath : `${GRAPH_ROOT}${urlOrPath}`);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({})) as T & GraphErrorPayload;
  if (!response.ok) {
    const code = payload.error?.code ? ` (${payload.error.code})` : "";
    throw new Error(`Microsoft Graph could not complete the request${code}. Check the connected account's file access.`);
  }
  return payload;
}

function encodePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!normalized) throw new Error("Enter the workbook path within the selected document library.");
  return normalized.split("/").map(encodeURIComponent).join("/");
}

function validateWorkbook(item: GraphDriveItem): void {
  const extension = (item.name ?? "").toLocaleLowerCase("en-GB").split(".").pop();
  if (extension !== "csv" && extension !== "xlsx") throw new Error("The selected Microsoft file must be .csv or .xlsx.");
  if (item.folder || !item.file) throw new Error("The selected Microsoft path is not a file.");
  if (item.size !== undefined && (!Number.isSafeInteger(item.size) || item.size < 0 || item.size > MAX_DOWNLOAD_BYTES)) {
    throw new Error("The selected Microsoft file exceeds the 10 MB ingestion limit.");
  }
}

function normalizeWorkbook(input: {
  sourceKind: "sharepoint" | "onedrive";
  siteId: string | null;
  driveId: string;
  item: GraphDriveItem;
}): ResolvedMicrosoftWorkbook {
  validateWorkbook(input.item);
  if (!input.item.id || !input.item.name) throw new Error("Microsoft returned an incomplete workbook record.");
  const modifiedAt = input.item.lastModifiedDateTime ? new Date(input.item.lastModifiedDateTime) : null;
  if (modifiedAt && !Number.isFinite(modifiedAt.getTime())) throw new Error("Microsoft returned an invalid workbook modification time.");
  return {
    sourceKind: input.sourceKind,
    siteId: input.siteId,
    driveId: input.driveId,
    driveItemId: input.item.id,
    sourceName: input.item.name,
    sourcePath: input.item.webUrl ?? input.item.parentReference?.path ?? input.item.name,
    sourceETag: input.item.eTag ?? null,
    sourceCTag: input.item.cTag ?? null,
    sourceModifiedAt: modifiedAt?.toISOString() ?? null,
    sizeBytes: input.item.size ?? null,
  };
}

export async function getMicrosoftAccount(accessToken: string): Promise<MicrosoftAccount> {
  const me = await graphJson<{ id?: string; displayName?: string; mail?: string; userPrincipalName?: string }>(
    accessToken,
    "/me?$select=id,displayName,mail,userPrincipalName",
  );
  if (!me.id) throw new Error("Microsoft returned an incomplete account profile.");
  return { id: me.id, displayName: me.displayName ?? null, email: me.mail ?? me.userPrincipalName ?? null };
}

export async function resolveMicrosoftWorkbook(input: {
  accessToken: string;
  sourceKind: "sharepoint" | "onedrive";
  workbookPath: string;
  siteUrl?: string;
}): Promise<ResolvedMicrosoftWorkbook> {
  const filePath = encodePath(input.workbookPath);
  if (input.sourceKind === "onedrive") {
    const drive = await graphJson<{ id?: string }>(input.accessToken, "/me/drive?$select=id");
    if (!drive.id) throw new Error("Microsoft returned no OneDrive for this account.");
    const item = await graphJson<GraphDriveItem>(input.accessToken, `/drives/${encodeURIComponent(drive.id)}/root:/${filePath}`);
    return normalizeWorkbook({ sourceKind: "onedrive", siteId: null, driveId: drive.id, item });
  }

  if (!input.siteUrl) throw new Error("Enter the SharePoint site URL that contains the workbook.");
  const siteUrl = new URL(input.siteUrl);
  if (siteUrl.protocol !== "https:" || !siteUrl.hostname.toLocaleLowerCase("en-GB").endsWith(".sharepoint.com")) {
    throw new Error("Enter a valid https://…sharepoint.com site URL.");
  }
  const sitePath = siteUrl.pathname.replace(/\/$/, "");
  if (!sitePath || sitePath === "/") throw new Error("Enter the full SharePoint site URL, for example /sites/Operations.");
  const site = await graphJson<{ id?: string }>(input.accessToken, `/sites/${encodeURIComponent(siteUrl.hostname)}:${sitePath}?$select=id`);
  if (!site.id) throw new Error("Microsoft returned no matching SharePoint site.");
  const drive = await graphJson<{ id?: string }>(input.accessToken, `/sites/${encodeURIComponent(site.id)}/drive?$select=id`);
  if (!drive.id) throw new Error("Microsoft returned no default document library for this site.");
  const item = await graphJson<GraphDriveItem>(input.accessToken, `/drives/${encodeURIComponent(drive.id)}/root:/${filePath}`);
  return normalizeWorkbook({ sourceKind: "sharepoint", siteId: site.id, driveId: drive.id, item });
}

export async function getMicrosoftWorkbook(input: {
  accessToken: string;
  driveId: string;
  driveItemId: string;
}): Promise<ResolvedMicrosoftWorkbook> {
  const item = await graphJson<GraphDriveItem>(
    input.accessToken,
    `/drives/${encodeURIComponent(input.driveId)}/items/${encodeURIComponent(input.driveItemId)}`,
  );
  return normalizeWorkbook({ sourceKind: "onedrive", siteId: null, driveId: input.driveId, item });
}

export async function downloadMicrosoftWorkbook(input: {
  accessToken: string;
  driveId: string;
  driveItemId: string;
}): Promise<Uint8Array> {
  const url = `${GRAPH_ROOT}/drives/${encodeURIComponent(input.driveId)}/items/${encodeURIComponent(input.driveItemId)}/content`;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${input.accessToken}` },
    cache: "no-store",
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error("Microsoft Graph could not download the selected workbook.");
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_DOWNLOAD_BYTES) {
    throw new Error("The selected Microsoft file exceeds the 10 MB ingestion limit.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error("Microsoft returned an empty workbook.");
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new Error("The selected Microsoft file exceeds the 10 MB ingestion limit.");
  return bytes;
}

export async function seedMicrosoftDriveDelta(accessToken: string, driveId: string): Promise<string> {
  const page = await graphJson<GraphDriveDeltaPage>(
    accessToken,
    `/drives/${encodeURIComponent(driveId)}/root/delta?token=latest`,
  );
  const plan = planSharePointDeltaPage({ page, selectedItemIds: new Set() });
  if (!plan.checkpointCandidate) throw new Error("Microsoft did not return an initial drive checkpoint.");
  return plan.checkpointCandidate;
}

export async function collectMicrosoftDriveDelta(input: {
  accessToken: string;
  deltaLink: string;
  selectedItemIds: ReadonlySet<string>;
}): Promise<{ changes: SharePointDeltaChange[]; deltaLink: string }> {
  let url: string | null = assertGraphDeltaUrl(input.deltaLink);
  let checkpoint: string | null = null;
  const latestChanges = new Map<string, SharePointDeltaChange>();
  let pages = 0;
  while (url) {
    pages += 1;
    if (pages > MAX_DELTA_PAGES) throw new Error("Microsoft Graph returned too many delta pages in one sync.");
    const page = await graphJson<GraphDriveDeltaPage>(input.accessToken, url);
    const plan = planSharePointDeltaPage({ page, selectedItemIds: input.selectedItemIds });
    for (const change of plan.changes) latestChanges.set(change.driveItemId, change);
    url = plan.nextPageUrl;
    checkpoint = plan.checkpointCandidate ?? checkpoint;
  }
  if (!checkpoint) throw new Error("Microsoft Graph did not complete the delta reconciliation.");
  return { changes: [...latestChanges.values()], deltaLink: checkpoint };
}
