const GRAPH_ORIGIN = "https://graph.microsoft.com";
const SUPPORTED_EXTENSIONS = new Set(["csv", "xlsx"]);

export interface GraphDriveItem {
  id: string;
  name?: string;
  eTag?: string;
  cTag?: string;
  size?: number;
  lastModifiedDateTime?: string;
  file?: { mimeType?: string };
  folder?: Record<string, unknown>;
  deleted?: Record<string, unknown>;
}

export interface GraphDriveDeltaPage {
  value: GraphDriveItem[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

export type SharePointDeltaChange =
  | {
      kind: "download";
      driveItemId: string;
      sourceName: string;
      sourceETag: string | null;
      sourceCTag: string | null;
      sourceModifiedAt: string | null;
      sizeBytes: number | null;
    }
  | { kind: "delete"; driveItemId: string };

export interface SharePointDeltaPlan {
  changes: SharePointDeltaChange[];
  nextPageUrl: string | null;
  checkpointCandidate: string | null;
}

export function assertGraphDeltaUrl(value: string): string {
  const url = new URL(value);
  if (url.origin !== GRAPH_ORIGIN || !url.pathname.startsWith("/v1.0/")) {
    throw new Error("Microsoft Graph returned an invalid delta continuation URL.");
  }
  return url.toString();
}

function extensionOf(name: string): string {
  return name.toLocaleLowerCase("en-GB").split(".").pop() ?? "";
}

function optionalIsoTimestamp(value: string | undefined): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("Microsoft Graph returned an invalid modification time.");
  return new Date(timestamp).toISOString();
}

export function planSharePointDeltaPage(input: {
  page: GraphDriveDeltaPage;
  selectedItemIds?: ReadonlySet<string>;
}): SharePointDeltaPlan {
  const nextLink = input.page["@odata.nextLink"];
  const deltaLink = input.page["@odata.deltaLink"];
  if (nextLink && deltaLink) throw new Error("Microsoft Graph returned both a next link and a delta checkpoint.");
  if (!nextLink && !deltaLink) throw new Error("Microsoft Graph returned no delta continuation or checkpoint.");

  // Graph may return the same item more than once in one feed. Its documented
  // contract is that the last occurrence is the current state.
  const latestById = new Map<string, GraphDriveItem>();
  for (const item of input.page.value) {
    if (!item.id) throw new Error("Microsoft Graph returned a drive item without an ID.");
    latestById.set(item.id, item);
  }

  const changes: SharePointDeltaChange[] = [];
  for (const item of latestById.values()) {
    if (input.selectedItemIds && !input.selectedItemIds.has(item.id)) continue;
    if (item.deleted) {
      changes.push({ kind: "delete", driveItemId: item.id });
      continue;
    }
    if (item.folder || !item.file || !item.name || !SUPPORTED_EXTENSIONS.has(extensionOf(item.name))) continue;
    if (item.size !== undefined && (!Number.isSafeInteger(item.size) || item.size < 0)) {
      throw new Error("Microsoft Graph returned an invalid file size.");
    }
    changes.push({
      kind: "download",
      driveItemId: item.id,
      sourceName: item.name,
      sourceETag: item.eTag ?? null,
      sourceCTag: item.cTag ?? null,
      sourceModifiedAt: optionalIsoTimestamp(item.lastModifiedDateTime),
      sizeBytes: item.size ?? null,
    });
  }

  return {
    changes,
    nextPageUrl: nextLink ? assertGraphDeltaUrl(nextLink) : null,
    // A delta link is only durable after the entire page sequence has been
    // consumed and its resulting loads commit successfully.
    checkpointCandidate: deltaLink ? assertGraphDeltaUrl(deltaLink) : null,
  };
}
