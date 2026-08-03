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

  const datasets = (details.datasets ?? []).map((dataset, index) => ({
    ...dataset,
    id: stableId(number, 400 + index),
  }));
  const datasetsByKey = new Map(datasets.map((dataset) => [dataset.key, dataset]));
  const kpis = (details.kpis ?? []).map((kpi, index) => {
    const dataset = datasetsByKey.get(kpi.datasetKey);
    if (!dataset) throw new Error(`Unknown dataset ${kpi.datasetKey}`);
    return {
      ...kpi,
      id: stableId(number, 500 + index),
      datasetId: dataset.id,
      values: kpi.values.map((value, valueIndex) => {
        const orgNode = byKey.get(value.orgKey);
        if (!orgNode) throw new Error(`Unknown KPI organisation node ${value.orgKey}`);
        return { ...value, id: stableId(number, 600 + index * 20 + valueIndex), orgNodeId: orgNode.id };
      }),
    };
  });

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
    datasets,
    kpis,
  };
}

export const DEMO_SEED_VERSION = "pulse-v1";
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
    datasets: [
      {
        key: "installation_performance",
        name: "Installation performance",
        subjectArea: "Operations",
        refreshCadence: "Daily by 07:00",
        expectedLatency: "1 day",
        sourceAge: "2 hours",
      },
      {
        key: "customer_service_performance",
        name: "Customer service performance",
        subjectArea: "Customer Care",
        refreshCadence: "Every 4 hours",
        expectedLatency: "6 hours",
        sourceAge: "3 days",
      },
    ],
    kpis: [
      {
        key: "first_time_completion",
        datasetKey: "installation_performance",
        name: "First-time completion",
        definition: "Percentage of completed installation jobs that did not require a repeat visit within the quality window.",
        businessPurpose: "Protect customer experience and reduce avoidable repeat visits.",
        formulaReference: "eligible_first_time_jobs / eligible_completed_jobs",
        ownerName: "Head of Field Operations",
        reviewerName: "Managing Director",
        unit: "percentage",
        decimalPlaces: 1,
        favourableDirection: "higher",
        aggregation: "ratio",
        thresholds: { green: { gte: 92 }, amber: { gte: 88 } },
        values: [
          { orgKey: "company", actual: 90.6, target: 92, prior: 89.4, numerator: 453, denominator: 500 },
          { orgKey: "north", actual: 89.8, target: 92, prior: 88.7, numerator: 269.4, denominator: 300 },
          { orgKey: "install-north", actual: 91.2, target: 92, prior: 90.1, numerator: 182.4, denominator: 200 },
          { orgKey: "aisha", actual: 94.0, target: 92, prior: 91.0, numerator: 47, denominator: 50 },
        ],
      },
      {
        key: "open_service_backlog",
        datasetKey: "customer_service_performance",
        name: "Open service backlog",
        definition: "Number of customer service requests still open at the reporting cut-off.",
        businessPurpose: "Expose ageing demand before service levels and customer outcomes deteriorate.",
        formulaReference: "count(open_service_requests)",
        ownerName: "Customer Service Director",
        reviewerName: "Managing Director",
        unit: "number",
        decimalPlaces: 0,
        favourableDirection: "lower",
        aggregation: "snapshot",
        thresholds: { green: { lte: 85 }, amber: { lte: 100 } },
        values: [
          { orgKey: "company", actual: 112, target: 85, prior: 97 },
          { orgKey: "customer-service", actual: 112, target: 85, prior: 97 },
          { orgKey: "service-desk", actual: 112, target: 85, prior: 97 },
        ],
      },
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
    datasets: [
      {
        key: "repair_performance",
        name: "Repair performance",
        subjectArea: "Operations",
        refreshCadence: "Daily by 08:00",
        expectedLatency: "1 day",
        sourceAge: "3 hours",
      },
    ],
    kpis: [
      {
        key: "repairs_completed_on_time",
        datasetKey: "repair_performance",
        name: "Repairs completed on time",
        definition: "Percentage of completed repair jobs finished within the agreed service window.",
        businessPurpose: "Track reliable delivery against customer commitments.",
        formulaReference: "on_time_repairs / completed_repairs",
        ownerName: "Operations Director",
        reviewerName: "Managing Director",
        unit: "percentage",
        decimalPlaces: 1,
        favourableDirection: "higher",
        aggregation: "ratio",
        thresholds: { green: { gte: 95 }, amber: { gte: 90 } },
        values: [
          { orgKey: "company", actual: 96.4, target: 95, prior: 94.8, numerator: 241, denominator: 250 },
          { orgKey: "repairs", actual: 96.4, target: 95, prior: 94.8, numerator: 241, denominator: 250 },
          { orgKey: "maya", actual: 98.0, target: 95, prior: 96.0, numerator: 49, denominator: 50 },
        ],
      },
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
      ...demoTenant.datasets.map((dataset) => dataset.id),
      ...demoTenant.kpis.flatMap((kpi) => [kpi.id, ...kpi.values.map((value) => value.id)]),
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
