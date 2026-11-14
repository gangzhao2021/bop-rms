import { KitchenWorkLifecycleError } from "../contracts/kitchen-work-lifecycle.js";
import {
  parseKitchenWorkLifecycleEffect,
  type KitchenWorkLifecycleEffectValidationPorts,
} from "./kitchen-work-lifecycle-service.js";
import type { KitchenWorkLifecycleEffect } from "./ports/kitchen-work-lifecycle-ports.js";

const maximumVersion = 9223372036854775807n;
const paths = new Set<string>();
const versions = [
  "expectedTicketVersion",
  "resultTicketVersion",
  "expectedWorkItemVersion",
  "resultWorkItemVersion",
];
for (const prefix of ["operation", "automaticReadyOperation", "mutation"])
  for (const field of versions) paths.add(prefix + "." + field);
for (const prefix of ["operation", "automaticReadyOperation"]) {
  for (const field of ["ticketVersion", "workItemVersion"])
    paths.add(prefix + ".admissionDecision." + field);
}
for (const prefix of ["operation", "automaticReadyOperation", "readyResult"])
  for (const field of [
    "sourceExpectedTicketVersion",
    "sourceCommittedTicketVersion",
    "sourceExpectedWorkItemVersion",
    "sourceCommittedWorkItemVersion",
  ])
    paths.add(prefix + ".capturedExpo." + field);
for (const path of [
  "readyResult.workItems.*.workItemVersion",
  "event.aggregateVersion",
  "readyPublication.ticketVersion",
  "readyPublication.itemEvent.aggregateVersion",
  "readyPublication.orderEvent.aggregateVersion",
])
  paths.add(path);

function fail(): never {
  throw new KitchenWorkLifecycleError("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE");
}
function restore(value: unknown, path: string): unknown {
  if (value === null) return null;
  if (paths.has(path)) {
    if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)) return fail();
    const version = BigInt(value);
    if (version > maximumVersion) return fail();
    return version;
  }
  if (Array.isArray(value)) return value.map((entry) => restore(entry, path + ".*"));
  if (typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        restore(entry, path ? path + "." + key : key),
      ]),
    );
  return value;
}

/** Restricted immutable owner storage; validate before invoking JSON serialization. */
export function encodeKitchenWorkLifecycleRecord(
  value: unknown,
  ports: KitchenWorkLifecycleEffectValidationPorts,
): string {
  try {
    const effect = parseKitchenWorkLifecycleEffect(value, ports);
    return JSON.stringify({ recordVersion: 1, effect }, (_key, entry: unknown) =>
      typeof entry === "bigint" ? entry.toString() : entry,
    );
  } catch {
    return fail();
  }
}

/** Explicit version restoration never reinterprets command/result version strings. */
export function decodeKitchenWorkLifecycleRecord(
  value: unknown,
  ports: KitchenWorkLifecycleEffectValidationPorts,
): KitchenWorkLifecycleEffect {
  try {
    if (typeof value !== "string") return fail();
    const record: unknown = JSON.parse(value);
    if (
      record === null ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      Object.keys(record).length !== 2 ||
      !("recordVersion" in record) ||
      record.recordVersion !== 1 ||
      !("effect" in record)
    )
      return fail();
    return parseKitchenWorkLifecycleEffect(restore(record.effect, ""), ports);
  } catch {
    return fail();
  }
}
