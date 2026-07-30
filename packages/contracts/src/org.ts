export type OrgNodeType =
  | "company"
  | "function"
  | "department"
  | "region"
  | "site"
  | "team"
  | "employee";

export interface OrgNode {
  orgNodeId: string;
  nodeType: OrgNodeType;
  name: string;
  parentId: string | null;
  managerUserId: string | null;
  linkedUserId: string | null;
  path: string;
  validFrom: string;
  validTo: string | null;
}
