import type { Method } from "@/lib/scan/provenance";

/*
 * Small label for how a number was made. Colors follow the light panel:
 * MEASURED sky, MODELED slate, SCENARIO amber, ESTIMATE slate outline.
 */
const STYLE: Record<Method, string> = {
  MEASURED: "border-[#bae6fd] bg-[#e0f2fe] text-[#0369a1]",
  MODELED: "border-[#cbd5e1] bg-[#f1f5f9] text-[#334155]",
  SCENARIO: "border-[#fcd34d] bg-[#fef3c7] text-[#b45309]",
  ESTIMATE: "border-[#94a3b8] bg-white text-[#334155]",
};

const TITLE: Record<Method, string> = {
  MEASURED: "Read from a dataset",
  MODELED: "Our own calculation from a model",
  SCENARIO: "A what-if, not a forecast",
  ESTIMATE: "A rough statewide estimate",
};

export function MethodBadge({ method }: { method: Method }) {
  return (
    <span
      title={TITLE[method]}
      className={`inline-block shrink-0 rounded-[4px] border px-1.5 py-px text-[11px] font-semibold uppercase leading-[16px] tracking-wide ${STYLE[method]}`}
    >
      {method}
    </span>
  );
}

export default MethodBadge;
