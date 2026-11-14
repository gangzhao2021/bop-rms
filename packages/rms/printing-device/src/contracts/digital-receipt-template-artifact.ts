import { parseDeviceReference, parseDeviceInstant } from "./device-management.js";
import {
  DigitalReceiptTemplateError,
  digitalReceiptRequiredFields,
} from "./digital-receipt-template.js";
const invalid = (): never => {
  throw new DigitalReceiptTemplateError();
};
export type DigitalReceiptTemplateArtifactKind = "Layout" | "Compliance";
export type DigitalReceiptTemplateArtifactContent =
  | Readonly<{
      profile: "AccessibleDigitalReceiptLayoutV1";
      dataContractVersion: 1;
      renderEngineVersion: 1;
      outputProfile: "AccessibleDigitalReceipt";
      requiredFields: readonly (typeof digitalReceiptRequiredFields)[number][];
    }>
  | Readonly<{
      profile: "DigitalReceiptRequiredFieldRuleV1";
      dataContractVersion: 1;
      requiredFields: readonly (typeof digitalReceiptRequiredFields)[number][];
      professionalReviewStatus: "NotEvaluated";
      legalConclusion: "NotEvaluated";
    }>;
export interface DigitalReceiptTemplateArtifactScope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
}
export interface DigitalReceiptTemplateArtifactActorScope extends DigitalReceiptTemplateArtifactScope {
  readonly actorReference: string;
}
export interface DigitalReceiptTemplateArtifactVersion extends DigitalReceiptTemplateArtifactScope {
  readonly profile: "DigitalReceiptTemplateArtifactV1";
  readonly artifactKind: DigitalReceiptTemplateArtifactKind;
  readonly artifactReference: string;
  readonly revision: number;
  readonly authoredByReference: string;
  readonly previousArtifactReference: string | null;
  readonly content: DigitalReceiptTemplateArtifactContent;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dataClassification: "Internal";
}
interface Original extends DigitalReceiptTemplateArtifactActorScope {
  readonly artifactKind: DigitalReceiptTemplateArtifactKind;
  readonly operationReference: string;
  readonly expectedArtifactReference: string | null;
  readonly expectedRevision: number;
  readonly purposeCode: "RECEIPT_TEMPLATE_ARTIFACT";
}
export interface DigitalReceiptTemplateArtifactSave extends Original {
  readonly profile: "DigitalReceiptTemplateArtifactSaveV1";
  readonly content: DigitalReceiptTemplateArtifactContent;
}
export interface DigitalReceiptTemplateArtifactResolve extends Original {
  readonly profile: "DigitalReceiptTemplateArtifactResolveV1";
  readonly intentDigest: string;
}
export interface DigitalReceiptTemplateArtifactReceipt extends DigitalReceiptTemplateArtifactActorScope {
  readonly profile: "DigitalReceiptTemplateArtifactReceiptV1";
  readonly artifactKind: DigitalReceiptTemplateArtifactKind;
  readonly operationReference: string;
  readonly intentDigest: string;
  readonly expectedArtifactReference: string | null;
  readonly expectedRevision: number;
  readonly outcome: "Committed" | "Abandoned";
  readonly snapshot: DigitalReceiptTemplateArtifactVersion | null;
  readonly auditReference: string;
  readonly occurredAt: string;
}
export interface DigitalReceiptTemplateArtifactCurrent extends DigitalReceiptTemplateArtifactActorScope {
  readonly profile: "DigitalReceiptTemplateArtifactsCurrentV1";
  readonly layout: DigitalReceiptTemplateArtifactVersion | null;
  readonly compliance: DigitalReceiptTemplateArtifactVersion | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly sourceQualification: "NotEvaluated";
}
/** Owning metadata inventory; not proof of authorization, publication or professional receipt review. */
export const digitalReceiptTemplateArtifactRequiredFields = Object.freeze([
  "tenantReference",
  "brandReference",
  "storeReference",
  "actorReference",
  "artifactKind",
  "operationReference",
  "expectedArtifactReference",
  "expectedRevision",
  "content",
  "intentDigest",
  "snapshot",
  "auditReference",
  "occurredAt",
] as const);

function protect<T>(work: () => T): T {
  try {
    return work();
  } catch {
    return invalid();
  }
}
function detached(value: unknown): unknown {
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
  if (new TextEncoder().encode(JSON.stringify(result)).length > 16384) return invalid();
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
const ref = (v: unknown): string => parseDeviceReference(v);
const kind = (v: unknown): DigitalReceiptTemplateArtifactKind =>
  v === "Layout" || v === "Compliance" ? v : invalid();
function revision(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > 2147483647)
    return invalid();
  return v;
}
function parseDigitalReceiptTemplateArtifactIntentDigest(v: unknown): string {
  if (typeof v !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(v)) return invalid();
  return v;
}
function scope(r: Record<string, unknown>): DigitalReceiptTemplateArtifactScope {
  return {
    tenantReference: ref(r.tenantReference),
    brandReference: ref(r.brandReference),
    storeReference: ref(r.storeReference),
  };
}
function pins(r: Record<string, unknown>) {
  const expectedRevision = revision(r.expectedRevision),
    expectedArtifactReference =
      r.expectedArtifactReference === null ? null : ref(r.expectedArtifactReference);
  if ((expectedRevision === 0) !== (expectedArtifactReference === null)) return invalid();
  return { expectedArtifactReference, expectedRevision };
}
function content(
  k: DigitalReceiptTemplateArtifactKind,
  v: unknown,
): DigitalReceiptTemplateArtifactContent {
  const r = closed(
    v,
    k === "Layout"
      ? ["profile", "dataContractVersion", "renderEngineVersion", "outputProfile", "requiredFields"]
      : [
          "profile",
          "dataContractVersion",
          "requiredFields",
          "professionalReviewStatus",
          "legalConclusion",
        ],
  );
  const suppliedFields = r.requiredFields;
  if (
    r.dataContractVersion !== 1 ||
    !Array.isArray(suppliedFields) ||
    suppliedFields.length !== digitalReceiptRequiredFields.length ||
    digitalReceiptRequiredFields.some((field, index) => suppliedFields[index] !== field)
  )
    return invalid();
  // The detached transport already checked dense descriptors. Rebuild the exact fixed
  // renderer contract, not an authored custom order or a claim of legal validation.
  const requiredFields = Object.freeze([...digitalReceiptRequiredFields]);
  if (k === "Layout") {
    if (
      r.profile !== "AccessibleDigitalReceiptLayoutV1" ||
      r.renderEngineVersion !== 1 ||
      r.outputProfile !== "AccessibleDigitalReceipt"
    )
      return invalid();
    return Object.freeze({
      profile: "AccessibleDigitalReceiptLayoutV1",
      dataContractVersion: 1,
      renderEngineVersion: 1,
      outputProfile: "AccessibleDigitalReceipt",
      requiredFields,
    });
  }
  if (
    r.profile !== "DigitalReceiptRequiredFieldRuleV1" ||
    r.professionalReviewStatus !== "NotEvaluated" ||
    r.legalConclusion !== "NotEvaluated"
  )
    return invalid();
  return Object.freeze({
    profile: "DigitalReceiptRequiredFieldRuleV1",
    dataContractVersion: 1,
    requiredFields,
    professionalReviewStatus: "NotEvaluated",
    legalConclusion: "NotEvaluated",
  });
}
export function parseDigitalReceiptTemplateArtifactContent(
  v: unknown,
  k: DigitalReceiptTemplateArtifactKind,
): DigitalReceiptTemplateArtifactContent {
  return protect(() => content(kind(k), detached(v)));
}
const scopeKeys = ["tenantReference", "brandReference", "storeReference"];
function version(v: unknown): DigitalReceiptTemplateArtifactVersion {
  const r = closed(v, [
    "profile",
    ...scopeKeys,
    "artifactKind",
    "artifactReference",
    "revision",
    "authoredByReference",
    "previousArtifactReference",
    "content",
    "createdAt",
    "updatedAt",
    "dataClassification",
  ]);
  const k = kind(r.artifactKind),
    rev = revision(r.revision),
    previousArtifactReference =
      r.previousArtifactReference === null ? null : ref(r.previousArtifactReference),
    artifactReference = ref(r.artifactReference),
    createdAt = parseDeviceInstant(r.createdAt),
    updatedAt = parseDeviceInstant(r.updatedAt);
  if (
    r.profile !== "DigitalReceiptTemplateArtifactV1" ||
    r.dataClassification !== "Internal" ||
    rev === 0 ||
    (rev === 1) !== (previousArtifactReference === null) ||
    previousArtifactReference === artifactReference ||
    updatedAt < createdAt ||
    (rev === 1 && createdAt !== updatedAt)
  )
    return invalid();
  return Object.freeze({
    profile: "DigitalReceiptTemplateArtifactV1",
    ...scope(r),
    artifactKind: k,
    artifactReference,
    revision: rev,
    authoredByReference: ref(r.authoredByReference),
    previousArtifactReference,
    content: content(k, r.content),
    createdAt,
    updatedAt,
    dataClassification: "Internal",
  });
}
export function parseDigitalReceiptTemplateArtifactVersion(
  v: unknown,
): DigitalReceiptTemplateArtifactVersion {
  return protect(() => version(detached(v)));
}
function original(r: Record<string, unknown>): Original {
  if (r.purposeCode !== "RECEIPT_TEMPLATE_ARTIFACT") return invalid();
  return {
    ...scope(r),
    actorReference: ref(r.actorReference),
    artifactKind: kind(r.artifactKind),
    operationReference: ref(r.operationReference),
    ...pins(r),
    purposeCode: "RECEIPT_TEMPLATE_ARTIFACT",
  };
}
const originalKeys = [
  ...scopeKeys,
  "actorReference",
  "artifactKind",
  "operationReference",
  "expectedArtifactReference",
  "expectedRevision",
  "purposeCode",
];
export function parseDigitalReceiptTemplateArtifactSave(
  v: unknown,
): DigitalReceiptTemplateArtifactSave {
  return protect(() => {
    const r = closed(detached(v), ["profile", ...originalKeys, "content"]);
    if (r.profile !== "DigitalReceiptTemplateArtifactSaveV1") return invalid();
    const o = original(r);
    if (o.expectedRevision === 2147483647) return invalid();
    return Object.freeze({
      profile: "DigitalReceiptTemplateArtifactSaveV1",
      ...o,
      content: content(o.artifactKind, r.content),
    });
  });
}
export function parseDigitalReceiptTemplateArtifactResolve(
  v: unknown,
): DigitalReceiptTemplateArtifactResolve {
  return protect(() => {
    const r = closed(detached(v), ["profile", ...originalKeys, "intentDigest"]);
    if (r.profile !== "DigitalReceiptTemplateArtifactResolveV1") return invalid();
    return Object.freeze({
      profile: "DigitalReceiptTemplateArtifactResolveV1",
      ...original(r),
      intentDigest: parseDigitalReceiptTemplateArtifactIntentDigest(r.intentDigest),
    });
  });
}
export function parseDigitalReceiptTemplateArtifactReceipt(
  v: unknown,
): DigitalReceiptTemplateArtifactReceipt {
  return protect(() => {
    const r = closed(detached(v), [
      "profile",
      ...scopeKeys,
      "actorReference",
      "artifactKind",
      "operationReference",
      "intentDigest",
      "expectedArtifactReference",
      "expectedRevision",
      "outcome",
      "snapshot",
      "auditReference",
      "occurredAt",
    ]);
    if (
      r.profile !== "DigitalReceiptTemplateArtifactReceiptV1" ||
      (r.outcome !== "Committed" && r.outcome !== "Abandoned")
    )
      return invalid();
    const s = scope(r),
      actorReference = ref(r.actorReference),
      k = kind(r.artifactKind),
      p = pins(r),
      occurredAt = parseDeviceInstant(r.occurredAt),
      snapshot = r.snapshot === null ? null : version(r.snapshot);
    if (r.outcome === "Abandoned" ? snapshot !== null : snapshot === null) return invalid();
    if (
      snapshot &&
      (snapshot.artifactKind !== k ||
        scopeKeys.some(
          (key) =>
            snapshot[key as keyof DigitalReceiptTemplateArtifactScope] !==
            s[key as keyof DigitalReceiptTemplateArtifactScope],
        ) ||
        snapshot.authoredByReference !== actorReference ||
        snapshot.revision !== p.expectedRevision + 1 ||
        snapshot.previousArtifactReference !== p.expectedArtifactReference ||
        snapshot.artifactReference === p.expectedArtifactReference ||
        snapshot.updatedAt !== occurredAt)
    )
      return invalid();
    return Object.freeze({
      profile: "DigitalReceiptTemplateArtifactReceiptV1",
      ...s,
      actorReference,
      artifactKind: k,
      operationReference: ref(r.operationReference),
      intentDigest: parseDigitalReceiptTemplateArtifactIntentDigest(r.intentDigest),
      ...p,
      outcome: r.outcome,
      snapshot,
      auditReference: ref(r.auditReference),
      occurredAt,
    });
  });
}
export function parseDigitalReceiptTemplateArtifactCurrent(
  v: unknown,
): DigitalReceiptTemplateArtifactCurrent {
  return protect(() => {
    const r = closed(detached(v), [
        "profile",
        ...scopeKeys,
        "actorReference",
        "layout",
        "compliance",
        "observedAt",
        "validUntil",
        "sourceQualification",
      ]),
      s = scope(r),
      observedAt = parseDeviceInstant(r.observedAt),
      validUntil = parseDeviceInstant(r.validUntil);
    if (
      r.profile !== "DigitalReceiptTemplateArtifactsCurrentV1" ||
      r.sourceQualification !== "NotEvaluated" ||
      validUntil <= observedAt ||
      Date.parse(validUntil) - Date.parse(observedAt) > 5000
    )
      return invalid();
    const layout = r.layout === null ? null : version(r.layout),
      compliance = r.compliance === null ? null : version(r.compliance);
    for (const [snapshot, k] of [
      [layout, "Layout"],
      [compliance, "Compliance"],
    ] as const)
      if (
        snapshot &&
        (snapshot.artifactKind !== k ||
          scopeKeys.some(
            (key) =>
              snapshot[key as keyof DigitalReceiptTemplateArtifactScope] !==
              s[key as keyof DigitalReceiptTemplateArtifactScope],
          ) ||
          snapshot.updatedAt > observedAt)
      )
        return invalid();
    return Object.freeze({
      profile: "DigitalReceiptTemplateArtifactsCurrentV1",
      ...s,
      actorReference: ref(r.actorReference),
      layout,
      compliance,
      observedAt,
      validUntil,
      sourceQualification: "NotEvaluated",
    });
  });
}
