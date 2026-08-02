const stableId = (tenantNumber, sequence) =>
  `${tenantNumber}0000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;

const pathLabel = (id) => id.replaceAll("-", "_");

function tenant(number, details) {
  const nodes = details.nodes.map((node, index) => ({
    ...node,
    id: stableId(number, 100 + index),
    versionId: stableId(number, 200 + index),
  }));
  const byKey = new Map(nodes.map((node) => [node.key, node]));

  for (const node of nodes) {
    const parent = node.parentKey ? byKey.get(node.parentKey) : null;
    if (node.parentKey && !parent) throw new Error(`Unknown parent ${node.parentKey}`);
    node.parentId = parent?.id ?? null;
    node.path = parent ? `${parent.path}.${pathLabel(node.id)}` : pathLabel(node.id);
  }

  return {
    id: stableId(number, 1),
    slug: details.slug,
    name: details.name,
    timezone: "Europe/London",
    seedPrincipal: {
      authUserId: stableId(number, 10),
      profileId: stableId(number, 11),
      membershipId: stableId(number, 12),
      email: `demo-seed-${details.slug}@hized.invalid`,
      name: `${details.name} seed administrator`,
    },
    nodes,
  };
}

export const DEMO_SEED_VERSION = "phase0-v1";
export const DEMO_VALID_FROM = "2026-01-01";

export const demoTenants = [
  tenant(1, {
    slug: "northstar-installations",
    name: "Northstar Installations",
    nodes: [
      { key: "company", type: "company", name: "Northstar Installations" },
      { key: "north", type: "region", name: "North Region", parentKey: "company" },
      { key: "south", type: "region", name: "South Region", parentKey: "company" },
      { key: "manchester", type: "site", name: "Manchester Hub", parentKey: "north" },
      { key: "install-north", type: "team", name: "North Installation Team", parentKey: "manchester" },
      { key: "aisha", type: "employee", name: "Aisha Khan", parentKey: "install-north" },
      { key: "service-north", type: "team", name: "North Service Team", parentKey: "manchester" },
      { key: "tom", type: "employee", name: "Tom Reeves", parentKey: "service-north" },
      { key: "sales", type: "function", name: "Sales", parentKey: "company" },
      { key: "customer-service", type: "function", name: "Customer Service", parentKey: "company" },
      { key: "service-desk", type: "team", name: "Service Desk", parentKey: "customer-service" },
      { key: "finance", type: "function", name: "Finance", parentKey: "company" },
    ],
  }),
  tenant(2, {
    slug: "harbour-field-services",
    name: "Harbour Field Services",
    nodes: [
      { key: "company", type: "company", name: "Harbour Field Services" },
      { key: "west", type: "region", name: "West Region", parentKey: "company" },
      { key: "bristol", type: "site", name: "Bristol Hub", parentKey: "west" },
      { key: "repairs", type: "team", name: "Repairs Team", parentKey: "bristol" },
      { key: "maya", type: "employee", name: "Maya Patel", parentKey: "repairs" },
      { key: "finance", type: "function", name: "Finance", parentKey: "company" },
    ],
  }),
];

export function validateDemoData() {
  if (demoTenants.length !== 2) throw new Error("EPIC-01 requires exactly two demo tenants.");

  const ids = new Set();
  const slugs = new Set();
  for (const demoTenant of demoTenants) {
    if (slugs.has(demoTenant.slug)) throw new Error(`Duplicate tenant slug ${demoTenant.slug}`);
    slugs.add(demoTenant.slug);

    const tenantIds = [
      demoTenant.id,
      demoTenant.seedPrincipal.authUserId,
      demoTenant.seedPrincipal.profileId,
      demoTenant.seedPrincipal.membershipId,
      ...demoTenant.nodes.flatMap((node) => [node.id, node.versionId]),
    ];
    for (const id of tenantIds) {
      if (ids.has(id)) throw new Error(`Duplicate stable ID ${id}`);
      ids.add(id);
    }

    const nodeIds = new Set(demoTenant.nodes.map((node) => node.id));
    const roots = demoTenant.nodes.filter((node) => node.parentId === null);
    if (roots.length !== 1 || roots[0].type !== "company") {
      throw new Error(`${demoTenant.slug} must have one company root.`);
    }
    for (const node of demoTenant.nodes) {
      if (node.parentId && !nodeIds.has(node.parentId)) {
        throw new Error(`${node.key} has a cross-tenant or missing parent.`);
      }
      if (!node.path.endsWith(pathLabel(node.id))) throw new Error(`Invalid path for ${node.key}`);
    }
  }
}

validateDemoData();
