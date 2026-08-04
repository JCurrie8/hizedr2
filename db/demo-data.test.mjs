import test from "node:test";
import assert from "node:assert/strict";
import { demoTenants, validateDemoData } from "./demo-data.mjs";

test("the EPIC-01 manifest contains two internally valid tenants", () => {
  assert.doesNotThrow(validateDemoData);
  assert.equal(demoTenants.length, 2);
  assert.notEqual(demoTenants[0].id, demoTenants[1].id);
});

test("the installation demo exposes the Phase 0 hierarchy needed for later KPI stories", () => {
  const nodeTypes = new Set(demoTenants[0].nodes.map((node) => node.type));
  for (const type of ["company", "region", "site", "team", "employee", "function"]) {
    assert.ok(nodeTypes.has(type), `missing ${type}`);
  }
  const names = new Set(demoTenants[0].nodes.map((node) => node.name));
  for (const name of ["Sales", "Customer Service", "Finance"]) {
    assert.ok(names.has(name), `missing ${name}`);
  }
});

test("the Pulse demo owns governed KPI definitions, target variance and a stale source", () => {
  const northstar = demoTenants[0];
  assert.equal(northstar.datasets.length, 2);
  assert.equal(northstar.kpis.length, 2);
  const completion = northstar.kpis.find((kpi) => kpi.key === "first_time_completion");
  assert.ok(completion);
  assert.ok(completion.values.some((value) => value.actual < value.target));
  const staleDataset = northstar.datasets.find((dataset) => dataset.key === "customer_service_performance");
  assert.equal(staleDataset.sourceAge, "3 days");
});

test("each demo tenant includes a published Pulse view and Canvas board", () => {
  for (const tenant of demoTenants) {
    assert.equal(tenant.views.length, 2);
    assert.ok(tenant.views.some((view) => view.surface === "pulse" && view.isDefault && view.status === "published"));
    assert.ok(tenant.views.some((view) => view.surface === "canvas" && view.visibility === "tenant"));
    assert.ok(tenant.views.every((view) => view.widgets.length > 0));
  }
});

test("no node can reference the other tenant's hierarchy", () => {
  const firstIds = new Set(demoTenants[0].nodes.map((node) => node.id));
  const secondIds = new Set(demoTenants[1].nodes.map((node) => node.id));
  for (const node of demoTenants[0].nodes) assert.ok(!node.parentId || firstIds.has(node.parentId));
  for (const node of demoTenants[1].nodes) assert.ok(!node.parentId || secondIds.has(node.parentId));
});
