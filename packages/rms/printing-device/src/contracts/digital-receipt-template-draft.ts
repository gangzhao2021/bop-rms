import { parseDeviceReference, parseDeviceInstant } from "./device-management.js";
import { DigitalReceiptTemplateError } from "./digital-receipt-template.js";
import {
  parseDigitalReceiptTemplateContent,
  type DigitalReceiptTemplateContent,
} from "./digital-receipt-template-content.js";
import {
  parseDigitalReceiptTemplateDraftFields,
  type DigitalReceiptTemplateDraftFields,
} from "./digital-receipt-template-draft-fields.js";
export interface DigitalReceiptTemplateDraftScope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
}
export interface DigitalReceiptTemplateDraftActorScope extends DigitalReceiptTemplateDraftScope {
  readonly actorReference: string;
}
export interface DigitalReceiptTemplateDraft extends DigitalReceiptTemplateDraftScope {
  readonly profile: "DigitalReceiptTemplateDraftV2";
  readonly familyReference: string;
  readonly revision: number;
  readonly authoredByReference: string;
  readonly previousVersionReference: string | null;
  readonly content: DigitalReceiptTemplateContent;
  readonly contentDigest: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dataClassification: "Internal";
}
interface Original extends DigitalReceiptTemplateDraftActorScope {
  readonly operationReference: string;
  readonly templateReference: string | null;
  readonly expectedVersionReference: string | null;
  readonly expectedRevision: number;
  readonly purposeCode: "RECEIPT_TEMPLATE_AUTHORING";
}
export interface DigitalReceiptTemplateDraftSave extends Original {
  readonly profile: "DigitalReceiptTemplateDraftSaveV1";
  readonly fields: DigitalReceiptTemplateDraftFields;
}
export interface DigitalReceiptTemplateDraftResolve extends Original {
  readonly profile: "DigitalReceiptTemplateDraftResolveV1";
  readonly intentDigest: string;
}
export interface DigitalReceiptTemplateDraftReceipt extends DigitalReceiptTemplateDraftActorScope {
  readonly profile: "DigitalReceiptTemplateDraftReceiptV1";
  readonly operationReference: string;
  readonly templateReference: string | null;
  readonly expectedVersionReference: string | null;
  readonly expectedRevision: number;
  readonly intentDigest: string;
  readonly outcome: "Committed" | "Abandoned";
  readonly snapshot: DigitalReceiptTemplateDraft | null;
  readonly auditReference: string;
  readonly occurredAt: string;
}
export interface DigitalReceiptTemplateDraftCurrent extends DigitalReceiptTemplateDraftActorScope {
  readonly profile: "DigitalReceiptTemplateDraftCurrentV1";
  readonly templateReference: string | null;
  readonly snapshot: DigitalReceiptTemplateDraft | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly sourceQualification: "NotEvaluated";
}
const invalid = (): never => {
  throw new DigitalReceiptTemplateError();
};
function protect<T>(work: () => T): T {
  try {
    return work();
  } catch {
    return invalid();
  }
}
function detached(value: unknown, maximumBytes = 16384): unknown {
  let nodes = 0;
  const copy = (v: unknown, depth: number): unknown => {
    if (++nodes > 10000 || depth > 16) return invalid();
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v !== "object") return invalid();
    if (Array.isArray(v)) {
      if (
        Object.getPrototypeOf(v) !== Array.prototype ||
        v.length > 10000 ||
        Reflect.ownKeys(v).length !== v.length + 1
      )
        return invalid();
      const result: unknown[] = [];
      for (let i = 0; i < v.length; i++) {
        const d = Object.getOwnPropertyDescriptor(v, String(i));
        if (!d?.enumerable || !("value" in d)) return invalid();
        result.push(copy(d.value, depth + 1));
      }
      return Object.freeze(result);
    }
    if (Object.getPrototypeOf(v) !== Object.prototype) return invalid();
    const out: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(v)) {
      if (typeof key !== "string" || key === "__proto__") return invalid();
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (!d?.enumerable || !("value" in d)) return invalid();
      Object.defineProperty(out, key, { value: copy(d.value, depth + 1), enumerable: true });
    }
    return Object.freeze(out);
  };
  const result = copy(value, 0);
  if (new TextEncoder().encode(JSON.stringify(result)).length > maximumBytes) return invalid();
  return result;
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    return invalid();
  return value as Record<string, unknown>;
}

const scopeKeys = ["tenantReference", "brandReference", "storeReference"];
const actorKeys = [...scopeKeys, "actorReference"];
const ref = (v: unknown) => parseDeviceReference(v);
const nullable = (v: unknown) => (v === null ? null : ref(v));
const hash = (v: unknown): string =>
  typeof v === "string" && /^sha256:[0-9a-f]{64}$/u.test(v) ? v : invalid();
function revision(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > 2147483647)
    return invalid();
  return v;
}
function scope(r: Record<string, unknown>): DigitalReceiptTemplateDraftScope {
  return {
    tenantReference: ref(r.tenantReference),
    brandReference: ref(r.brandReference),
    storeReference: ref(r.storeReference),
  };
}
function actor(r: Record<string, unknown>): DigitalReceiptTemplateDraftActorScope {
  return { ...scope(r), actorReference: ref(r.actorReference) };
}
function pins(r: Record<string, unknown>) {
  const templateReference = nullable(r.templateReference),
    expectedVersionReference = nullable(r.expectedVersionReference),
    expectedRevision = revision(r.expectedRevision);
  if (
    expectedRevision === 0
      ? templateReference !== null || expectedVersionReference !== null
      : templateReference === null || expectedVersionReference === null
  )
    return invalid();
  return { templateReference, expectedVersionReference, expectedRevision };
}
function draft(v: unknown): DigitalReceiptTemplateDraft {
  const r = closed(v, [
      "profile",
      ...scopeKeys,
      "familyReference",
      "revision",
      "authoredByReference",
      "previousVersionReference",
      "content",
      "contentDigest",
      "createdAt",
      "updatedAt",
      "dataClassification",
    ]),
    s = scope(r),
    n = revision(r.revision),
    content = parseDigitalReceiptTemplateContent(r.content),
    previousVersionReference = nullable(r.previousVersionReference),
    createdAt = parseDeviceInstant(r.createdAt),
    updatedAt = parseDeviceInstant(r.updatedAt);
  if (
    r.profile !== "DigitalReceiptTemplateDraftV2" ||
    r.dataClassification !== "Internal" ||
    n === 0 ||
    (n === 1) !== (previousVersionReference === null) ||
    previousVersionReference === content.versionReference ||
    createdAt > updatedAt ||
    (n === 1 && createdAt !== updatedAt) ||
    scopeKeys.some(
      (k) =>
        s[k as keyof DigitalReceiptTemplateDraftScope] !==
        content[k as keyof DigitalReceiptTemplateDraftScope],
    )
  )
    return invalid();
  return Object.freeze({
    profile: "DigitalReceiptTemplateDraftV2",
    ...s,
    familyReference: ref(r.familyReference),
    revision: n,
    authoredByReference: ref(r.authoredByReference),
    previousVersionReference,
    content,
    contentDigest: hash(r.contentDigest),
    createdAt,
    updatedAt,
    dataClassification: "Internal",
  });
}
export function parseDigitalReceiptTemplateDraft(v: unknown): DigitalReceiptTemplateDraft {
  return protect(() => draft(detached(v)));
}
const originalKeys = [
  ...actorKeys,
  "operationReference",
  "templateReference",
  "expectedVersionReference",
  "expectedRevision",
  "purposeCode",
];
function original(r: Record<string, unknown>) {
  if (r.purposeCode !== "RECEIPT_TEMPLATE_AUTHORING") return invalid();
  return {
    ...actor(r),
    operationReference: ref(r.operationReference),
    ...pins(r),
    purposeCode: "RECEIPT_TEMPLATE_AUTHORING" as const,
  };
}
export function parseDigitalReceiptTemplateDraftSave(v: unknown): DigitalReceiptTemplateDraftSave {
  return protect(() => {
    const r = closed(detached(v), ["profile", ...originalKeys, "fields"]),
      o = original(r);
    if (r.profile !== "DigitalReceiptTemplateDraftSaveV1" || o.expectedRevision === 2147483647)
      return invalid();
    return Object.freeze({
      profile: "DigitalReceiptTemplateDraftSaveV1",
      ...o,
      fields: parseDigitalReceiptTemplateDraftFields(r.fields),
    });
  });
}
export function parseDigitalReceiptTemplateDraftResolve(
  v: unknown,
): DigitalReceiptTemplateDraftResolve {
  return protect(() => {
    const r = closed(detached(v), ["profile", ...originalKeys, "intentDigest"]);
    if (r.profile !== "DigitalReceiptTemplateDraftResolveV1") return invalid();
    return Object.freeze({
      profile: "DigitalReceiptTemplateDraftResolveV1",
      ...original(r),
      intentDigest: hash(r.intentDigest),
    });
  });
}
export function parseDigitalReceiptTemplateDraftReceipt(
  v: unknown,
): DigitalReceiptTemplateDraftReceipt {
  return protect(() => {
    const r = closed(detached(v), [
        "profile",
        ...actorKeys,
        "operationReference",
        "templateReference",
        "expectedVersionReference",
        "expectedRevision",
        "intentDigest",
        "outcome",
        "snapshot",
        "auditReference",
        "occurredAt",
      ]),
      s = actor(r),
      p = pins(r),
      snapshot = r.snapshot === null ? null : draft(r.snapshot),
      occurredAt = parseDeviceInstant(r.occurredAt);
    if (
      r.profile !== "DigitalReceiptTemplateDraftReceiptV1" ||
      (r.outcome !== "Committed" && r.outcome !== "Abandoned") ||
      (r.outcome === "Abandoned") !== (snapshot === null)
    )
      return invalid();
    if (
      snapshot &&
      (scopeKeys.some(
        (k) =>
          snapshot[k as keyof DigitalReceiptTemplateDraftScope] !==
          s[k as keyof DigitalReceiptTemplateDraftScope],
      ) ||
        snapshot.revision !== p.expectedRevision + 1 ||
        snapshot.authoredByReference !== s.actorReference ||
        snapshot.previousVersionReference !== p.expectedVersionReference ||
        snapshot.updatedAt !== occurredAt ||
        (p.templateReference !== null &&
          snapshot.content.templateReference !== p.templateReference))
    )
      return invalid();
    return Object.freeze({
      profile: "DigitalReceiptTemplateDraftReceiptV1",
      ...s,
      operationReference: ref(r.operationReference),
      ...p,
      intentDigest: hash(r.intentDigest),
      outcome: r.outcome,
      snapshot,
      auditReference: ref(r.auditReference),
      occurredAt,
    });
  });
}
export function parseDigitalReceiptTemplateDraftCurrent(
  v: unknown,
): DigitalReceiptTemplateDraftCurrent {
  return protect(() => {
    const r = closed(detached(v), [
        "profile",
        ...actorKeys,
        "templateReference",
        "snapshot",
        "observedAt",
        "validUntil",
        "sourceQualification",
      ]),
      s = actor(r),
      templateReference = nullable(r.templateReference),
      snapshot = r.snapshot === null ? null : draft(r.snapshot),
      observedAt = parseDeviceInstant(r.observedAt),
      validUntil = parseDeviceInstant(r.validUntil);
    if (
      r.profile !== "DigitalReceiptTemplateDraftCurrentV1" ||
      r.sourceQualification !== "NotEvaluated" ||
      validUntil <= observedAt ||
      Date.parse(validUntil) - Date.parse(observedAt) > 5000
    )
      return invalid();
    if (
      snapshot &&
      (templateReference !== snapshot.content.templateReference ||
        scopeKeys.some(
          (k) =>
            snapshot[k as keyof DigitalReceiptTemplateDraftScope] !==
            s[k as keyof DigitalReceiptTemplateDraftScope],
        ) ||
        snapshot.updatedAt > observedAt)
    )
      return invalid();
    return Object.freeze({
      profile: "DigitalReceiptTemplateDraftCurrentV1",
      ...s,
      templateReference,
      snapshot,
      observedAt,
      validUntil,
      sourceQualification: "NotEvaluated",
    });
  });
}

/** Bounded current-page observations, not a stable whole-Store snapshot. */
export interface DigitalReceiptTemplateDraftRoster extends DigitalReceiptTemplateDraftActorScope {
  readonly profile: "DigitalReceiptTemplateDraftRosterV1";
  readonly afterTemplate: string | null;
  readonly entries: readonly DigitalReceiptTemplateDraft[];
  readonly nextAfter: string | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly sourceQualification: "NotEvaluated";
}
export function parseDigitalReceiptTemplateDraftRoster(
  v: unknown,
): DigitalReceiptTemplateDraftRoster {
  return protect(() => {
    const r = closed(detached(v, 335872), [
        "profile",
        ...actorKeys,
        "afterTemplate",
        "entries",
        "nextAfter",
        "observedAt",
        "validUntil",
        "sourceQualification",
      ]),
      s = actor(r),
      afterTemplate = nullable(r.afterTemplate),
      nextAfter = nullable(r.nextAfter),
      observedAt = parseDeviceInstant(r.observedAt),
      validUntil = parseDeviceInstant(r.validUntil);
    if (
      r.profile !== "DigitalReceiptTemplateDraftRosterV1" ||
      r.sourceQualification !== "NotEvaluated" ||
      validUntil <= observedAt ||
      Date.parse(validUntil) - Date.parse(observedAt) > 5000 ||
      !Array.isArray(r.entries) ||
      r.entries.length > 20
    )
      return invalid();
    const entries = Object.freeze(
      r.entries.map((value) => parseDigitalReceiptTemplateDraft(value)),
    );
    let previous = afterTemplate;
    for (const entry of entries) {
      if (
        scopeKeys.some(
          (k) =>
            entry[k as keyof DigitalReceiptTemplateDraftScope] !==
            s[k as keyof DigitalReceiptTemplateDraftScope],
        ) ||
        entry.updatedAt > observedAt ||
        (previous !== null && entry.content.templateReference <= previous)
      )
        return invalid();
      previous = entry.content.templateReference;
    }
    if (nextAfter !== null && (entries.length !== 20 || nextAfter !== previous)) return invalid();
    return Object.freeze({
      profile: "DigitalReceiptTemplateDraftRosterV1",
      ...s,
      afterTemplate,
      entries,
      nextAfter,
      observedAt,
      validUntil,
      sourceQualification: "NotEvaluated",
    });
  });
}
