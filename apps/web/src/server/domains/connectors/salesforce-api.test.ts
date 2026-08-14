import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authenticateSalesforce,
  describeSalesforceObject,
  discoverSalesforceObjects,
  extractSalesforceRecords,
  normalizeSalesforceDomain,
  resolveSalesforceApiVersion,
} from "./salesforce-api";

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("Salesforce REST adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("allows Salesforce HTTPS domains and rejects SSRF-shaped endpoints", () => {
    expect(normalizeSalesforceDomain("https://activ8.my.salesforce.com/path")).toBe("https://activ8.my.salesforce.com");
    expect(() => normalizeSalesforceDomain("http://activ8.my.salesforce.com")).toThrow(/HTTPS/);
    expect(() => normalizeSalesforceDomain("https://salesforce.com.attacker.example")).toThrow(/salesforce.com/);
    expect(() => normalizeSalesforceDomain("https://user:pass@activ8.my.salesforce.com")).toThrow(/without credentials/);
  });

  it("authenticates, selects a supported API version and discovers only queryable objects", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "token", instance_url: "https://activ8.my.salesforce.com" }))
      .mockResolvedValueOnce(jsonResponse([{ version: "66.0" }, { version: "67.0" }]))
      .mockResolvedValueOnce(jsonResponse({ sobjects: [
        { name: "Account", label: "Accounts", queryable: true, custom: false },
        { name: "Hidden__c", label: "Hidden", queryable: false, custom: true },
      ] }));
    vi.stubGlobal("fetch", fetchMock);
    const session = await authenticateSalesforce({
      myDomainUrl: "https://activ8.my.salesforce.com",
      clientId: "consumer-key",
      clientSecret: "consumer-secret",
    });
    const version = await resolveSalesforceApiVersion(session);
    const objects = await discoverSalesforceObjects(session, version);
    expect(version).toBe("67.0");
    expect(objects).toEqual([{ name: "Account", label: "Accounts", custom: false }]);
    const tokenRequest = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(String(tokenRequest.body)).toContain("grant_type=client_credentials");
  });

  it("describes scalar fields and chooses the strongest available watermark", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      name: "Account",
      label: "Accounts",
      queryable: true,
      fields: [
        { name: "Id", label: "ID", type: "id", queryable: true, nillable: false },
        { name: "SystemModstamp", label: "System Modstamp", type: "datetime", queryable: true, nillable: false },
        { name: "IsDeleted", label: "Deleted", type: "boolean", queryable: true, nillable: false },
        { name: "AnnualRevenue", label: "Annual Revenue", type: "currency", queryable: true, nillable: true },
        { name: "BillingAddress", label: "Billing Address", type: "address", queryable: true, nillable: true },
      ],
    })));
    const description = await describeSalesforceObject(
      { accessToken: "token", instanceUrl: "https://activ8.my.salesforce.com" },
      "67.0",
      "Account",
    );
    expect(description).toMatchObject({ modifiedField: "SystemModstamp", supportsDeleted: true });
    expect(description.fields.map((field) => field.name)).not.toContain("BillingAddress");
    expect(description.fields.find((field) => field.name === "AnnualRevenue")?.dataType).toBe("numeric");
  });

  it("uses queryAll, a bounded overlap window and Salesforce continuation URLs", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        done: false,
        nextRecordsUrl: "/services/data/v67.0/query/locator-2000",
        records: [{ attributes: { type: "Account" }, Id: "001A", SystemModstamp: "2026-08-14T10:00:00.000+0000", IsDeleted: false }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        done: true,
        records: [{ attributes: { type: "Account" }, Id: "001B", SystemModstamp: "2026-08-14T11:00:00.000+0000", IsDeleted: true }],
      }));
    vi.stubGlobal("fetch", fetchMock);
    const records = await extractSalesforceRecords({
      session: { accessToken: "token", instanceUrl: "https://activ8.my.salesforce.com" },
      apiVersion: "67.0",
      objectName: "Account",
      fields: ["Id", "SystemModstamp", "IsDeleted"],
      modifiedField: "SystemModstamp",
      windowFrom: new Date("2026-08-13T12:00:00Z"),
      windowTo: new Date("2026-08-14T12:00:00Z"),
      includeDeleted: true,
    });
    expect(records).toHaveLength(2);
    const firstUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(firstUrl.pathname).toContain("/queryAll/");
    expect(firstUrl.searchParams.get("q")).toContain("SystemModstamp >= 2026-08-13T12:00:00Z");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/services/data/v67.0/query/locator-2000");
  });
});
