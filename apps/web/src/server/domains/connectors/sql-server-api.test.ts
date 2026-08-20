import { describe, expect, it } from "vitest";
import { isPublicSqlAddress, normalizeSqlServerHost, quoteSqlServerIdentifier } from "./sql-server-api";
import { normalizeDestinationColumnName } from "./sql-server-destination-api";

describe("SQL Server adapter input hardening", () => {
  it("normalizes a hosted DNS target without accepting a connection string", () => {
    expect(normalizeSqlServerHost("tcp:ACTIV8-SQL.example.com.")).toBe("activ8-sql.example.com");
    expect(() => normalizeSqlServerHost("https://sql.example.com")).toThrow(/DNS host name/);
    expect(() => normalizeSqlServerHost("localhost")).toThrow(/cannot target/);
    expect(() => normalizeSqlServerHost("server\\SQLEXPRESS")).toThrow(/without a protocol/);
  });

  it("quotes only bounded identifiers", () => {
    expect(quoteSqlServerIdentifier("Sales Orders")).toBe("[Sales Orders]");
    expect(() => quoteSqlServerIdentifier("Orders]; drop table x;--")).toThrow(/identifier/);
  });

  it("refuses private, loopback and documentation addresses for hosted extraction", () => {
    expect(isPublicSqlAddress("20.42.1.10")).toBe(true);
    expect(isPublicSqlAddress("2603:1030:20e:3::23c")).toBe(true);
    expect(isPublicSqlAddress("10.0.0.4")).toBe(false);
    expect(isPublicSqlAddress("172.20.4.9")).toBe(false);
    expect(isPublicSqlAddress("192.168.1.2")).toBe(false);
    expect(isPublicSqlAddress("127.0.0.1")).toBe(false);
    expect(isPublicSqlAddress("169.254.169.254")).toBe(false);
    expect(isPublicSqlAddress("::1")).toBe(false);
    expect(isPublicSqlAddress("fd00::1")).toBe(false);
    expect(isPublicSqlAddress("2001:db8::1")).toBe(false);
  });

  it("turns source headings into deterministic, collision-safe SQL destination columns", () => {
    const used = new Set<string>();
    expect(normalizeDestinationColumnName("Account Name", used)).toBe("Account_Name");
    expect(normalizeDestinationColumnName("2026 value (£)", used)).toBe("field_2026_value");
    expect(normalizeDestinationColumnName("Account-Name", used)).toMatch(/^Account_Name_[0-9a-f]{10}$/);
    expect(new Set([...used]).size).toBe(3);
  });
});
