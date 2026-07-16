import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Ajv, type ErrorObject } from "ajv/dist/ajv.js";
import { parse } from "yaml";

export interface ScreenRecord {
  screen_id: string;
  aliases: string[];
  kind: "page" | "embedded" | "contextual" | "alias";
  surface: "customer_pwa" | "merchant_web" | "operations_web" | "platform_operations";
  route_mode: "standalone" | "embedded" | "contextual" | "alias";
  canonical_route?: string;
  parent_screen_ids?: string[];
  allowed_family?: string;
  alias_of?: string;
  family: string;
  phase: string;
  feature_gate: string;
  permission_ref: string;
  projection_ref: string;
  action_summary: string;
  command_refs: string[];
  work_package_mode: "resolved" | "inherited";
  work_packages: string[];
  navigation_targets: string[];
}
export interface ScreenRegistry {
  schema_version: string;
  catalogs: {
    families: string[];
    permissions: string[];
    projections: string[];
    work_packages: string[];
  };
  screens: ScreenRecord[];
}
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function readRegistry(path = "docs/product/screen-registry.yaml"): ScreenRegistry {
  return parse(readFileSync(path, "utf8")) as ScreenRegistry;
}
export function readSchema(path = "docs/product/screen-registry.schema.json"): object {
  return JSON.parse(readFileSync(path, "utf8")) as object;
}
function schemaError(error: ErrorObject) {
  return `schema ${error.instancePath || "/"} ${error.message ?? "is invalid"}`;
}

export function validateRegistry(registry: ScreenRegistry, schema: object): ValidationResult {
  const errors: string[] = [];
  const ajv = new Ajv({ allErrors: true, strict: true, strictRequired: false });
  const validate = ajv.compile(schema);
  if (!validate(registry)) errors.push(...(validate.errors ?? []).map(schemaError));
  const byId = new Map<string, ScreenRecord>();
  const routeOwners = new Map<string, string>();
  for (const screen of registry.screens ?? []) {
    if (byId.has(screen.screen_id)) errors.push(`duplicate screen_id ${screen.screen_id}`);
    else byId.set(screen.screen_id, screen);
    if (screen.route_mode === "standalone" && screen.canonical_route) {
      const prior = routeOwners.get(screen.canonical_route);
      if (prior)
        errors.push(
          `duplicate standalone route ${screen.canonical_route}: ${prior}, ${screen.screen_id}`,
        );
      else routeOwners.set(screen.canonical_route, screen.screen_id);
    }
  }
  const families = new Set(registry.catalogs?.families ?? []);
  const permissions = new Set(registry.catalogs?.permissions ?? []);
  const projections = new Set(registry.catalogs?.projections ?? []);
  const workPackages = new Set(registry.catalogs?.work_packages ?? []);
  const namespaces = {
    customer_pwa: [
      "/menu",
      "/cart",
      "/checkout",
      "/orders",
      "/account",
      "/reservations",
      "/waitlist",
      "/dine-in",
    ],
    merchant_web: ["/app"],
    operations_web: ["/operations"],
    platform_operations: ["/platform"],
  } as const;
  for (const screen of registry.screens ?? []) {
    if (!families.has(screen.family))
      errors.push(`invalid family ${screen.family} on ${screen.screen_id}`);
    if (!permissions.has(screen.permission_ref))
      errors.push(`unknown permission ${screen.permission_ref} on ${screen.screen_id}`);
    if (!projections.has(screen.projection_ref))
      errors.push(`unknown projection ${screen.projection_ref} on ${screen.screen_id}`);
    for (const wp of screen.work_packages ?? [])
      if (!workPackages.has(wp)) errors.push(`unknown work package ${wp} on ${screen.screen_id}`);
    if (screen.work_package_mode === "resolved" && !screen.work_packages?.length)
      errors.push(`missing resolved work package on ${screen.screen_id}`);
    if (!screen.phase || !screen.feature_gate)
      errors.push(`missing phase/feature gate on ${screen.screen_id}`);
    if (
      (screen.route_mode === "embedded" || screen.route_mode === "contextual") &&
      !screen.parent_screen_ids?.length &&
      !screen.allowed_family
    )
      errors.push(`missing parent/family on ${screen.screen_id}`);
    if (screen.allowed_family && !families.has(screen.allowed_family))
      errors.push(`invalid allowed family ${screen.allowed_family} on ${screen.screen_id}`);
    for (const parent of screen.parent_screen_ids ?? [])
      if (!byId.has(parent)) errors.push(`invalid parent ${parent} on ${screen.screen_id}`);
    for (const target of screen.navigation_targets ?? [])
      if (!byId.has(target))
        errors.push(`broken navigation target ${target} on ${screen.screen_id}`);
    if (screen.route_mode !== "alias" && screen.command_refs.length === 0)
      errors.push(`action mapping missing command on ${screen.screen_id}`);
    if (screen.route_mode !== "alias" && !screen.permission_ref)
      errors.push(`action mapping missing permission on ${screen.screen_id}`);
    if (screen.route_mode === "standalone" && screen.canonical_route) {
      const accepted = namespaces[screen.surface].some((prefix) =>
        screen.canonical_route?.startsWith(prefix),
      );
      if (!accepted)
        errors.push(
          `surface collision ${screen.surface} ${screen.canonical_route} on ${screen.screen_id}`,
        );
    }
  }
  const visitState = new Map<string, "visiting" | "visited">();
  function visit(id: string, path: string[]) {
    const screen = byId.get(id);
    if (!screen || screen.route_mode !== "alias") return;
    if (!screen.alias_of || !byId.has(screen.alias_of)) {
      errors.push(`unknown alias target ${screen.alias_of ?? "missing"} on ${id}`);
      return;
    }
    if (visitState.get(id) === "visiting") {
      errors.push(`alias cycle ${[...path, id].join(" -> ")}`);
      return;
    }
    if (visitState.get(id) === "visited") return;
    visitState.set(id, "visiting");
    visit(screen.alias_of, [...path, id]);
    visitState.set(id, "visited");
  }
  for (const screen of registry.screens ?? []) visit(screen.screen_id, []);
  return { valid: errors.length === 0, errors };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = validateRegistry(readRegistry(), readSchema());
  if (!result.valid) {
    console.error(result.errors.join("\n"));
    process.exitCode = 1;
  } else console.log("Screen Registry valid: 210 Section 88 records");
}
