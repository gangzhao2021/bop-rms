import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { stringify } from "yaml";
const { values } = parseArgs({
  options: { source: { type: "string" }, output: { type: "string" } },
});
if (!values.source || !values.output)
  throw new Error("usage: --source <canonical handoff> --output <registry yaml>");
const document = readFileSync(values.source, "utf8");
const start = document.indexOf("## 88. Complete Page");
const end = document.indexOf("## 89. Repository");
if (start < 0 || end < 0 || end <= start)
  throw new Error("canonical Section 88/89 boundaries were not found");
const section = document.slice(start, end);
const allowed = new Set([
  "88.6",
  "88.7",
  "88.8",
  "88.10",
  "88.11",
  "88.12",
  "88.14",
  "88.15",
  "88.16",
  "88.17",
  "88.18",
  "88.19",
]);
const aliasTargets = {
  "INV-STOCK-COUNT": "INV-COUNT-LIST",
  "INV-STOCK-ADJUSTMENT": "INV-ADJUSTMENT-WIZARD",
  "INV-STOCK-TRANSFER": "INV-TRANSFER-LIST",
  "INV-WASTE-RECORD": "INV-WASTE-WIZARD",
};
const explicitParents = {
  "CUST-SELLABLE-CONFIGURE": ["CUST-SELLABLE-DETAIL"],
  "CUST-ALLERGEN-ASSIST": ["CUST-SELLABLE-CONFIGURE"],
  "CUST-PICKUP-CODE": ["CUST-ORDER-STATUS"],
  "CAT-MENU-PUBLISH": ["CAT-MENU-BUILDER"],
  "OPS-ORDER-AMEND": ["OPS-ORDER-DETAIL"],
  "OPS-ORDER-EXCEPTION": ["OPS-ORDER-DETAIL"],
  "PAY-REFUND-WIZARD": ["PAY-PAYMENT-DETAIL"],
  "KIT-EXCEPTION": ["KIT-KITCHEN-QUEUE"],
  "FUL-PICKUP-HANDOFF": ["FUL-PICKUP-QUEUE"],
  "DIN-SESSION-START": ["DIN-FLOOR-BOARD"],
  "RES-CREATE-EDIT": ["RES-CALENDAR"],
  "WAIT-ENTRY": ["WAIT-BOARD"],
  "CRM-MERGE-REVIEW": ["CRM-CUSTOMER-DETAIL"],
};
const families = [
  "customer_journey",
  "master_list",
  "master_detail",
  "create_edit",
  "configuration_builder",
  "transaction_explorer",
  "live_workbench",
  "exception_case",
  "dashboard_monitoring",
  "wizard",
  "utility",
];
const permissions = [
  "customer.public",
  "customer.authenticated",
  "organization.manage",
  "identity.manage",
  "workflow.operate",
  "media.manage",
  "catalog.manage",
  "ordering.operate",
  "payment.operate",
  "kitchen.operate",
  "fulfillment.operate",
  "dining.operate",
  "inventory.manage",
  "procurement.manage",
  "customer.manage",
  "reporting.read",
  "compliance.manage",
  "integration.manage",
  "platform.operate",
  "audit.read",
  "shared.inherited",
];
const projections = [
  "organization_*_v1",
  "catalog_*_v1",
  "pricing_*_v1",
  "recipe_*_v1",
  "merchant_order_*_v1",
  "payment_*_v1",
  "kitchen_*_v1",
  "dining_*_v1",
  "reservation_*_v1",
  "fulfillment_*_v1",
  "inventory_*_v1",
  "procurement_*_v1",
  "customer_loyalty_*_v1",
  "reporting_*_v1",
  "compliance_*_v1",
  "device_integration_*_v1",
  "platform_*_v1",
  "inherited",
];
const prefixDomain = {
  CUST: "ordering",
  HOME: "organization",
  ORG: "organization",
  STORE: "organization",
  IAM: "identity",
  TASK: "workflow",
  MEDIA: "media",
  FEATURE: "organization",
  CAT: "catalog",
  PRICE: "pricing",
  TAX: "pricing",
  PROMO: "pricing",
  RECIPE: "recipe",
  IMPORT: "catalog",
  EXPORT: "workflow",
  OPS: "ordering",
  PAY: "payment",
  KIT: "kitchen",
  FUL: "fulfillment",
  DIN: "dining",
  RES: "reservation",
  WAIT: "reservation",
  INV: "inventory",
  SUP: "procurement",
  PROC: "procurement",
  CRM: "customer",
  LOY: "customer",
  CONSENT: "customer",
  COMMS: "customer",
  PRIVACY: "compliance",
  RPT: "reporting",
  BI: "reporting",
  CMP: "compliance",
  TRACE: "compliance",
  RECALL: "compliance",
  DEV: "integration",
  OUT: "integration",
  INT: "integration",
  PLT: "platform",
  AUDIT: "audit",
  HISTORY: "audit",
  VERSION: "audit",
  APPROVAL: "workflow",
  ALERT: "workflow",
  LOOKUP: "shared",
  IMPACT: "shared",
};
const projectionByDomain = {
  organization: "organization_*_v1",
  identity: "organization_*_v1",
  workflow: "organization_*_v1",
  media: "organization_*_v1",
  catalog: "catalog_*_v1",
  pricing: "pricing_*_v1",
  recipe: "recipe_*_v1",
  ordering: "merchant_order_*_v1",
  payment: "payment_*_v1",
  kitchen: "kitchen_*_v1",
  fulfillment: "fulfillment_*_v1",
  dining: "dining_*_v1",
  reservation: "reservation_*_v1",
  inventory: "inventory_*_v1",
  procurement: "procurement_*_v1",
  customer: "customer_loyalty_*_v1",
  reporting: "reporting_*_v1",
  compliance: "compliance_*_v1",
  integration: "device_integration_*_v1",
  platform: "platform_*_v1",
  audit: "platform_*_v1",
  shared: "inherited",
};
const permissionByDomain = {
  organization: "organization.manage",
  identity: "identity.manage",
  workflow: "workflow.operate",
  media: "media.manage",
  catalog: "catalog.manage",
  pricing: "catalog.manage",
  recipe: "catalog.manage",
  ordering: "ordering.operate",
  payment: "payment.operate",
  kitchen: "kitchen.operate",
  fulfillment: "fulfillment.operate",
  dining: "dining.operate",
  reservation: "dining.operate",
  inventory: "inventory.manage",
  procurement: "procurement.manage",
  customer: "customer.manage",
  reporting: "reporting.read",
  compliance: "compliance.manage",
  integration: "integration.manage",
  platform: "platform.operate",
  audit: "audit.read",
  shared: "shared.inherited",
};

function domainFor(id, prefix) {
  if (!id.startsWith("CUST-")) return prefixDomain[prefix] ?? "shared";
  if (/^CUST-(MENU|SELLABLE)/.test(id)) return "catalog";
  if (id === "CUST-ALLERGEN-ASSIST") return "recipe";
  if (/^CUST-(PAYMENT|CHECKOUT-RESULT)/.test(id)) return "payment";
  if (/^CUST-(PICKUP|DELIVERY)/.test(id)) return "fulfillment";
  if (/^CUST-(LOYALTY|PROFILE|ACCOUNT)/.test(id)) return "customer";
  if (/^CUST-(RESERVATION|WAITLIST)/.test(id)) return "reservation";
  if (id === "CUST-ENTRY-CONTEXT") return "organization";
  return "ordering";
}
function customerPermission(id) {
  return /^CUST-(LOYALTY|PROFILE|ACCOUNT|RESERVATION|WAITLIST)/.test(id)
    ? "customer.authenticated"
    : "customer.public";
}
function clean(value) {
  return (
    value.replaceAll("`", "").replace(/\*\*/g, "").trim() || "inherited from Section 88 parent"
  );
}
function ids(cell) {
  return [...cell.matchAll(/`([A-Z][A-Z0-9]+(?:-[A-Z0-9]+)+)`/g)].map((match) => match[1]);
}
function familyFor(id, source) {
  if (id.startsWith("CUST-")) return "customer_journey";
  if (/WIZARD|SETUP|CREATE-EDIT/.test(id)) return "wizard";
  if (/QUEUE|BOARD|WORKBENCH|WORK-ITEM|TERMINAL/.test(id)) return "live_workbench";
  if (/DASHBOARD|OVERVIEW|HEALTH/.test(id)) return "dashboard_monitoring";
  if (/EXCEPTION|CASE|INCIDENT|FINDING|RECONCILIATION/.test(id)) return "exception_case";
  if (/EDITOR|BUILDER|CONFIG|CAPABILITY|POLICY/.test(id)) return "configuration_builder";
  if (/CREATE|EDIT$/.test(id)) return "create_edit";
  if (/LIST|CATALOG|LIBRARY|EXPLORER/.test(id)) return "master_list";
  if (/DETAIL|STATUS|PROFILE|RECEIPT/.test(id)) return "master_detail";
  if (/contextual|embedded/i.test(source) || /HISTORY|COMPARE|PICKER|DIALOG/.test(id))
    return "utility";
  return "transaction_explorer";
}
function phaseFor(text) {
  if (/Future Trigger/i.test(text)) return ["future_trigger", "future_trigger_disabled"];
  if (/Phase 1A/i.test(text)) return ["phase_1a", "phase_capability"];
  if (/Later Phase 1/i.test(text)) return ["later_phase_1", "phase_capability"];
  if (/Phase 0\+/i.test(text)) return ["phase_0_plus", "phase_capability"];
  if (/Phase 1–3|Phase 1-3|Phase 2–3|Phase 2-3/i.test(text))
    return ["cross_phase", "phase_capability"];
  const match = text.match(/Phase\s+([0-9])/i);
  return match
    ? [`phase_${match[1]}`, "phase_capability"]
    : ["inherited", "inherited_feature_gate"];
}
function workPackages(text) {
  const result = [];
  for (const match of text.matchAll(/WP-(\d{4})(?:[–-](\d{4}))?/g)) {
    const first = Number(match[1]);
    const last = Number(match[2] ?? match[1]);
    if (last >= first && last - first <= 50)
      for (let number = first; number <= last; number += 1)
        result.push(`WP-${String(number).padStart(4, "0")}`);
    else result.push(`WP-${match[1]}`);
  }
  return [...new Set(result)].sort();
}
function routeFrom(source) {
  return source.match(/`(\/(?:[^`\s]+))`/)?.[1];
}
function routeFor(id, source, allIds) {
  const raw = routeFrom(source);
  if (!raw) return undefined;
  if (!raw.includes("...")) return raw.replace(/:([A-Za-z][A-Za-z0-9]*)/g, "{$1}");
  const base = raw.replace(/\.\.\.$/, "").replace(/\/$/, "");
  if (/-LIST$/.test(id)) return base;
  if (/-CREATE$/.test(id)) return `${base}/new`;
  if (/-EDIT$|-EDITOR$/.test(id)) return `${base}/{id}/edit`;
  if (/-DETAIL$/.test(id)) return `${base}/{id}`;
  if (id === allIds[0]) return base;
  return undefined;
}
function modeFor(id, source, placement, route) {
  if (aliasTargets[id]) return "alias";
  if (/Embedded/i.test(source) || /embedded/i.test(placement)) return "embedded";
  if (
    /contextual/i.test(source) ||
    /contextual|picker|action/i.test(placement) ||
    explicitParents[id]
  )
    return "contextual";
  return route ? "standalone" : "contextual";
}
function surfaceFor(id, route) {
  if (id.startsWith("CUST-")) return "customer_pwa";
  if (
    route?.startsWith("/platform") ||
    id.startsWith("PLT-") ||
    ["INT-WEBHOOK-INBOX", "INT-DEAD-LETTER"].includes(id)
  )
    return "platform_operations";
  if (route?.startsWith("/operations") || id === "PAY-TERMINAL") return "operations_web";
  return "merchant_web";
}
function roleList(text) {
  return clean(text)
    .split(/[；;]/)
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 4);
}
const rows = [];
let current = "";
for (const line of section.split(/\r?\n/)) {
  const heading = line.match(/^### (88\.\d+)/);
  if (heading) current = heading[1];
  if (!allowed.has(current) || !line.startsWith("|")) continue;
  const cells = line
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
  const rowIds = ids(cells[0] ?? "");
  if (rowIds.length) rows.push({ section: current, cells, rowIds });
}
const screens = [];
for (const row of rows) {
  const regular = row.cells.length >= 6;
  const [first, views, search, actions, access, phaseCell] = regular
    ? row.cells
    : [
        row.cells[0],
        row.cells[1],
        "inherits parent Screen",
        "inherits parent Screen",
        row.cells[2],
        row.cells[2],
      ];
  for (const id of row.rowIds) {
    const prefix = id.split("-")[0];
    const domain = domainFor(id, prefix);
    const route = routeFor(id, first, row.rowIds);
    const routeMode = modeFor(id, first, access, route);
    const [phase, featureGate] = phaseFor(phaseCell);
    const family = familyFor(id, `${first} ${access}`);
    const screen = {
      screen_id: id,
      aliases: [],
      kind: routeMode === "standalone" ? "page" : routeMode,
      surface: surfaceFor(id, route),
      route_mode: routeMode,
      family,
      capability: `${domain}.${id.toLowerCase().replaceAll("-", "_")}`,
      owning_domain: domain,
      object_or_workflow: id.toLowerCase().replaceAll("-", "_"),
      phase,
      feature_gate: featureGate,
      roles: id.startsWith("CUST-")
        ? ["Guest / Customer according to Section 88"]
        : roleList(access),
      permission_ref: id.startsWith("CUST-") ? customerPermission(id) : permissionByDomain[domain],
      scope: id.startsWith("CUST-")
        ? "Guest Session and exact Store / journey scope"
        : "Tenant, Brand, Store, Actor, purpose and field permission",
      mandatory_field_groups: [clean(views)],
      search_filter_sort_export: clean(search),
      query_ref: `query.${id.toLowerCase().replaceAll("-", "_")}`,
      projection_ref: routeMode === "alias" ? "inherited" : projectionByDomain[domain],
      freshness: "Section 88.22 projection target or inherited parent freshness",
      action_summary: clean(actions),
      command_refs:
        routeMode === "alias" ? [] : [`handoff_intent.${id.toLowerCase().replaceAll("-", "_")}`],
      idempotency:
        routeMode === "alias"
          ? "inherited"
          : "required for every mutation intent; query intents are side-effect free",
      states: [
        "Loading",
        "Empty",
        "Permission Denied",
        "Not Found",
        "Feature Disabled",
        "Stale",
        "Conflict",
        "Command Failed",
        "Offline Read-only",
      ],
      responsive_accessibility: "Sections 88.4 and 88.27-88.30 universal profile",
      analytics_privacy: "Section 88.28 allowlist and exclusions",
      work_package_mode: workPackages(phaseCell).length ? "resolved" : "inherited",
      work_packages: workPackages(phaseCell),
      handoff_section: row.section,
      route_intent: clean(first),
      navigation_targets: [
        ...(explicitParents[id] ?? []),
        ...(aliasTargets[id] ? [aliasTargets[id]] : []),
      ],
    };
    if (routeMode === "standalone" && route) {
      screen.canonical_route = route;
      screen.navigation_level_1 = route.startsWith("/app/")
        ? (route.split("/")[2] ?? "Home")
        : route.startsWith("/operations")
          ? "Operations"
          : route.startsWith("/platform")
            ? "Platform Operations"
            : "Customer Journey";
      screen.navigation_level_2 = id;
    }
    if (routeMode === "alias") screen.alias_of = aliasTargets[id];
    if (["embedded", "contextual"].includes(routeMode)) {
      if (explicitParents[id]) screen.parent_screen_ids = explicitParents[id];
      else screen.allowed_family = family;
    }
    screens.push(screen);
  }
}
screens.sort((left, right) => left.screen_id.localeCompare(right.screen_id));
for (const alias of screens.filter((screen) => screen.kind === "alias")) {
  const target = screens.find((screen) => screen.screen_id === alias.alias_of);
  if (target) target.aliases.push(alias.screen_id);
}
if (screens.length !== 210) throw new Error(`expected 210 screens, found ${screens.length}`);
const workPackagesCatalog = [...new Set(screens.flatMap((screen) => screen.work_packages))].sort();
const registry = {
  schema_version: "1.0.0",
  source: {
    document_id: "BOP-RMS-HANDOFF",
    document_version: "0.5.3",
    architecture_baseline: "v1.0",
    handoff_section: "88",
    figma_file_key: "EzKN98LGO4D4sEDkHp81Lb",
    mapping_node: "25:2",
  },
  catalogs: { families, permissions, projections, work_packages: workPackagesCatalog },
  screens,
};
writeFileSync(values.output, stringify(registry, { lineWidth: 0 }), "utf8");
globalThis.console.log(`wrote ${screens.length} screens to ${values.output}`);
