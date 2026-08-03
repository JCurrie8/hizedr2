import type { AppRole } from "@hized/contracts";
import type { GovernedDatasetOption } from "@/server/domains/pulse/kpi-governance";
import { KPI_AGGREGATIONS, KPI_NODE_TYPES, KPI_TARGET_METHODS } from "@/server/domains/pulse/kpi-governance";
import type { KpiCatalogueEntry } from "@/server/domains/pulse/kpis";

const roles: Array<{ value: AppRole; label: string }> = [
  { value: "company_admin", label: "Company Admin" },
  { value: "executive", label: "Executive" },
  { value: "functional_leader", label: "Functional leader" },
  { value: "manager", label: "Manager" },
  { value: "analyst", label: "Analyst" },
  { value: "employee", label: "End user" },
];

const inputClass = "mt-1 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink";
const labelClass = "text-sm font-semibold text-ink";

export function KpiDefinitionForm({
  action,
  datasets,
  definition,
}: {
  action: (formData: FormData) => Promise<void>;
  datasets: GovernedDatasetOption[];
  definition?: KpiCatalogueEntry;
}) {
  const selectedNodes = new Set(definition?.applicableNodeTypes ?? KPI_NODE_TYPES);
  const selectedRoles = new Set<AppRole>(definition?.audienceRoles ?? roles.map((role) => role.value));
  return (
    <form action={action} className="mt-5 grid gap-5 border-t border-line pt-5 sm:grid-cols-2">
      {definition ? <input type="hidden" name="definitionId" value={definition.id} /> : null}
      <label className={labelClass}>Governed dataset
        <select name="datasetId" required defaultValue={definition?.dataset.id ?? ""} className={inputClass}>
          <option value="" disabled>Choose a published dataset</option>
          {datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.subjectArea} — {dataset.name}</option>)}
        </select>
      </label>
      <label className={labelClass}>KPI key
        <input name="key" required pattern="[a-z][a-z0-9_]*" readOnly={Boolean(definition)} defaultValue={definition?.key} placeholder="first_time_completion" className={inputClass} />
      </label>
      <label className={labelClass}>Name
        <input name="name" required maxLength={120} defaultValue={definition?.name} className={inputClass} />
      </label>
      <label className={labelClass}>Effective from
        <input type="date" name="validFrom" required defaultValue={definition?.validFrom ?? ""} className={inputClass} />
      </label>
      <label className={`${labelClass} sm:col-span-2`}>Plain-English definition
        <textarea name="definition" required rows={3} defaultValue={definition?.definition} className={inputClass} />
      </label>
      <label className={`${labelClass} sm:col-span-2`}>Business purpose
        <textarea name="businessPurpose" required rows={2} defaultValue={definition?.businessPurpose} className={inputClass} />
      </label>
      <label className={`${labelClass} sm:col-span-2`}>Formula or calculation reference
        <input name="formulaReference" required defaultValue={definition?.formulaReference} placeholder="eligible_jobs_completed_first_time / eligible_jobs" className={inputClass} />
      </label>
      <label className={labelClass}>Business owner
        <input name="ownerName" required defaultValue={definition?.ownerName} className={inputClass} />
      </label>
      <label className={labelClass}>Reviewer
        <input name="reviewerName" required defaultValue={definition?.reviewerName} className={inputClass} />
      </label>
      <label className={labelClass}>Unit
        <select name="unit" defaultValue={definition?.unit ?? "number"} className={inputClass}>
          {['number', 'percentage', 'currency', 'duration', 'score'].map((unit) => <option key={unit} value={unit}>{unit}</option>)}
        </select>
      </label>
      <label className={labelClass}>Currency code <span className="font-normal text-muted">(currency only)</span>
        <input name="currencyCode" maxLength={3} defaultValue={definition?.currencyCode ?? ""} placeholder="GBP" className={inputClass} />
      </label>
      <label className={labelClass}>Decimal places
        <input type="number" name="decimalPlaces" min={0} max={6} defaultValue={definition?.decimalPlaces ?? 0} className={inputClass} />
      </label>
      <label className={labelClass}>Favourable direction
        <select name="favourableDirection" defaultValue={definition?.favourableDirection ?? "higher"} className={inputClass}>
          <option value="higher">Higher is better</option><option value="lower">Lower is better</option><option value="target">Closest to target</option>
        </select>
      </label>
      <label className={labelClass}>Aggregation
        <select name="aggregation" defaultValue={definition?.aggregation ?? "sum"} className={inputClass}>
          {KPI_AGGREGATIONS.map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}
        </select>
      </label>
      <label className={labelClass}>Target method
        <select name="targetMethod" defaultValue={definition?.targetMethod ?? "period_specific"} className={inputClass}>
          {KPI_TARGET_METHODS.map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}
        </select>
      </label>
      <label className={labelClass}>Refresh cadence
        <input name="refreshCadence" required defaultValue={definition?.refreshCadence} placeholder="Daily by 07:00" className={inputClass} />
      </label>
      <label className={labelClass}>Permitted dimensions <span className="font-normal text-muted">(comma separated)</span>
        <input name="permittedDimensions" defaultValue={definition?.permittedDimensions.join(", ")} placeholder="date, region, team" className={inputClass} />
      </label>
      <fieldset className="sm:col-span-2">
        <legend className={labelClass}>Applicable organisation levels</legend>
        <div className="mt-2 flex flex-wrap gap-3">
          {KPI_NODE_TYPES.map((value) => <label key={value} className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" name="applicableNodeTypes" value={value} defaultChecked={selectedNodes.has(value)} />{value}</label>)}
        </div>
      </fieldset>
      <fieldset className="sm:col-span-2">
        <legend className={labelClass}>Audience roles</legend>
        <div className="mt-2 flex flex-wrap gap-3">
          {roles.map((role) => <label key={role.value} className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" name="audienceRoles" value={role.value} defaultChecked={selectedRoles.has(role.value)} />{role.label}</label>)}
        </div>
      </fieldset>
      <label className={`${labelClass} sm:col-span-2`}>Threshold bands <span className="font-normal text-muted">(JSON contract)</span>
        <textarea name="thresholds" rows={3} defaultValue={JSON.stringify(definition?.thresholds ?? {}, null, 2)} className={`${inputClass} font-mono`} />
        <span className="mt-1 block text-xs font-normal text-muted">Example: {`{"green":{"min":92},"amber":{"min":88}}`}</span>
      </label>
      <div className="sm:col-span-2">
        <button type="submit" className="rounded-lg bg-teal-deep px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal">
          {definition ? `Save draft v${definition.version}` : "Create KPI draft"}
        </button>
      </div>
    </form>
  );
}
