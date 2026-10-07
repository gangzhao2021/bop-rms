import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  parsePlatformActor,
  assertPlatformSessionCurrent,
  parsePlatformSessionMfa,
  type AuthenticationSession,
  type PlatformSessionMfa,
} from "@bop/identity";

export const platformPermissionPurpose = "PLATFORM_BRAND_TEMPLATE" as const;
export const platformPermissionActions = [
  "platform.operate",
  "platform.brand-template.read",
  "platform.brand-template.manage",
  "platform.brand-template.submit",
  "platform.brand-template.approve",
  "platform.brand-template.publish",
  "platform.brand-template.archive",
] as const;
export type PlatformPermissionAction = (typeof platformPermissionActions)[number];
export interface PlatformPermissionScope {
  readonly kind: "Platform";
  readonly actorReference: string;
  readonly purposeCode: typeof platformPermissionPurpose;
}
export interface PlatformPermissionEntry {
  readonly evidenceReference: string;
  readonly action: PlatformPermissionAction;
  readonly effect: "Allow" | "Deny";
  readonly effectiveFrom: string;
  readonly effectiveUntil: string;
}
export interface PlatformPermissionContent {
  readonly roleCode: "PlatformAdministrator" | "PlatformSupport";
  readonly effectiveFrom: string;
  readonly effectiveUntil: string;
  readonly entries: readonly PlatformPermissionEntry[];
}
export interface PlatformPermissionHead {
  readonly policyReference: string;
  readonly revision: number;
  readonly sourceDigest: string;
}
export interface PlatformPermissionProvisionCommand {
  readonly profile: "PlatformPermissionProvisionV1";
  readonly targetActorReference: string;
  readonly purposeCode: typeof platformPermissionPurpose;
  readonly operationReference: string;
  readonly expectedHead: PlatformPermissionHead | null;
  readonly content: PlatformPermissionContent;
  readonly recordedByReference: string;
  readonly approvedByReference: string;
  readonly approvalEvidenceReference: string;
  readonly reasonCode: string;
}
export interface PlatformPermissionPolicy {
  readonly profile: "PlatformPermissionPolicyV1";
  readonly actorReference: string;
  readonly purposeCode: typeof platformPermissionPurpose;
  readonly policyReference: string;
  readonly revision: number;
  readonly supersedesPolicyReference: string | null;
  readonly content: PlatformPermissionContent;
  readonly operationReference: string;
  readonly intentDigest: string;
  readonly originalCommand: PlatformPermissionProvisionCommand;
  readonly recordedByReference: string;
  readonly approvedByReference: string;
  readonly approvalEvidenceReference: string;
  readonly reasonCode: string;
  readonly auditReference: string;
  readonly recordedAt: string;
  readonly sourceDigest: string;
  readonly classification: "RestrictedSecurity";
}
export interface PlatformPermissionIdentityObservation {
  readonly session: AuthenticationSession;
  readonly recentMfa: PlatformSessionMfa;
  readonly observedAt: string;
  readonly validUntil: string;
}
export interface PlatformPermissionAuthorization {
  readonly profile: "PlatformPermissionAuthorizationV1";
  readonly scope: PlatformPermissionScope;
  readonly action: PlatformPermissionAction;
  readonly policyReference: string;
  readonly policyRevision: number;
  readonly policySourceDigest: string;
  readonly operateEvidenceReference: string;
  readonly actionEvidenceReference: string;
  readonly observedAt: string;
  readonly validUntil: string;
}
export class PlatformPermissionError extends Error {
  readonly code:
    | "PLATFORM_PERMISSION_INPUT_INVALID"
    | "PLATFORM_PERMISSION_DENIED"
    | "PLATFORM_PERMISSION_UNAVAILABLE"
    | "PLATFORM_PERMISSION_VERSION_CONFLICT"
    | "PLATFORM_PERMISSION_INTENT_CONFLICT";
  constructor(code: PlatformPermissionError["code"] = "PLATFORM_PERMISSION_INPUT_INVALID") {
    super("Platform permission operation is unavailable");
    this.name = "PlatformPermissionError";
    this.code = code;
  }
}
export const platformPermissionFail = (code?: PlatformPermissionError["code"]): never => {
  throw new PlatformPermissionError(code);
};
export function platformPermissionClosed(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    return platformPermissionFail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== fields.length) return platformPermissionFail();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const d = descriptors[field];
    if (!d?.enumerable || !("value" in d)) return platformPermissionFail();
    result[field] = d.value;
  }
  return result;
}
export function parsePlatformPermissionReference(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  )
    return platformPermissionFail();
  return value;
}
export function parsePlatformPermissionInstant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    value.startsWith("0000-") ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  )
    return platformPermissionFail();
  return value;
}
const digest = (value: unknown): string => {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value))
    return platformPermissionFail();
  return value;
};
const revision = (value: unknown): number => {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 2147483647)
    return platformPermissionFail();
  return value as number;
};
export function parsePlatformPermissionAction(value: unknown): PlatformPermissionAction {
  if (!platformPermissionActions.includes(value as PlatformPermissionAction))
    return platformPermissionFail();
  return value as PlatformPermissionAction;
}
export function parsePlatformPermissionScope(value: unknown): PlatformPermissionScope {
  const r = platformPermissionClosed(value, ["kind", "actorReference", "purposeCode"]);
  if (r.kind !== "Platform" || r.purposeCode !== platformPermissionPurpose)
    return platformPermissionFail();
  return Object.freeze({
    kind: "Platform",
    actorReference: parsePlatformPermissionReference(r.actorReference),
    purposeCode: platformPermissionPurpose,
  });
}
export function parsePlatformPermissionHead(value: unknown): PlatformPermissionHead {
  const r = platformPermissionClosed(value, ["policyReference", "revision", "sourceDigest"]);
  return Object.freeze({
    policyReference: parsePlatformPermissionReference(r.policyReference),
    revision: revision(r.revision),
    sourceDigest: digest(r.sourceDigest),
  });
}
export function parsePlatformPermissionContent(value: unknown): PlatformPermissionContent {
  const r = platformPermissionClosed(value, [
    "roleCode",
    "effectiveFrom",
    "effectiveUntil",
    "entries",
  ]);
  if (r.roleCode !== "PlatformAdministrator" && r.roleCode !== "PlatformSupport")
    return platformPermissionFail();
  const from = parsePlatformPermissionInstant(r.effectiveFrom),
    until = parsePlatformPermissionInstant(r.effectiveUntil);
  if (
    from >= until ||
    !Array.isArray(r.entries) ||
    Object.getPrototypeOf(r.entries) !== Array.prototype ||
    r.entries.length > 14 ||
    Reflect.ownKeys(r.entries).length !== r.entries.length + 1
  )
    return platformPermissionFail();
  const ids = new Set<string>(),
    pairs = new Set<string>(),
    entries: PlatformPermissionEntry[] = [];
  for (let index = 0; index < r.entries.length; index++) {
    const d = Object.getOwnPropertyDescriptor(r.entries, String(index));
    if (!d?.enumerable || !("value" in d)) return platformPermissionFail();
    const item = platformPermissionClosed(d.value, [
      "evidenceReference",
      "action",
      "effect",
      "effectiveFrom",
      "effectiveUntil",
    ]);
    const evidenceReference = parsePlatformPermissionReference(item.evidenceReference),
      action = parsePlatformPermissionAction(item.action),
      effectiveFrom = parsePlatformPermissionInstant(item.effectiveFrom),
      effectiveUntil = parsePlatformPermissionInstant(item.effectiveUntil);
    if (
      (item.effect !== "Allow" && item.effect !== "Deny") ||
      effectiveFrom >= effectiveUntil ||
      effectiveFrom < from ||
      effectiveUntil > until ||
      ids.has(evidenceReference) ||
      pairs.has(`${action}:${item.effect}`) ||
      (r.roleCode === "PlatformSupport" &&
        item.effect === "Allow" &&
        action !== "platform.operate" &&
        action !== "platform.brand-template.read")
    )
      return platformPermissionFail();
    ids.add(evidenceReference);
    pairs.add(`${action}:${item.effect}`);
    entries.push(
      Object.freeze({
        evidenceReference,
        action,
        effect: item.effect,
        effectiveFrom,
        effectiveUntil,
      }),
    );
  }
  entries.sort((a, b) =>
    a.action < b.action
      ? -1
      : a.action > b.action
        ? 1
        : a.effect < b.effect
          ? -1
          : a.effect > b.effect
            ? 1
            : 0,
  );
  return Object.freeze({
    roleCode: r.roleCode,
    effectiveFrom: from,
    effectiveUntil: until,
    entries: Object.freeze(entries),
  });
}
export function parsePlatformPermissionProvisionCommand(
  value: unknown,
): PlatformPermissionProvisionCommand {
  const r = platformPermissionClosed(value, [
    "profile",
    "targetActorReference",
    "purposeCode",
    "operationReference",
    "expectedHead",
    "content",
    "recordedByReference",
    "approvedByReference",
    "approvalEvidenceReference",
    "reasonCode",
  ]);
  if (
    r.profile !== "PlatformPermissionProvisionV1" ||
    r.purposeCode !== platformPermissionPurpose ||
    typeof r.reasonCode !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,127}$/u.test(r.reasonCode)
  )
    return platformPermissionFail();
  const recordedByReference = parsePlatformPermissionReference(r.recordedByReference),
    approvedByReference = parsePlatformPermissionReference(r.approvedByReference);
  if (recordedByReference === approvedByReference) return platformPermissionFail();
  return Object.freeze({
    profile: "PlatformPermissionProvisionV1",
    targetActorReference: parsePlatformPermissionReference(r.targetActorReference),
    purposeCode: platformPermissionPurpose,
    operationReference: parsePlatformPermissionReference(r.operationReference),
    expectedHead: r.expectedHead === null ? null : parsePlatformPermissionHead(r.expectedHead),
    content: parsePlatformPermissionContent(r.content),
    recordedByReference,
    approvedByReference,
    approvalEvidenceReference: parsePlatformPermissionReference(r.approvalEvidenceReference),
    reasonCode: r.reasonCode,
  });
}
export const platformPermissionIntentDigest = (value: unknown): string =>
  `sha256:${sha256Hex(canonicalizeRfc8785(parsePlatformPermissionProvisionCommand(value)))}`;
export function buildPlatformPermissionPolicy(
  value: Omit<PlatformPermissionPolicy, "sourceDigest">,
): PlatformPermissionPolicy {
  return parsePlatformPermissionPolicy({
    ...value,
    sourceDigest: `sha256:${sha256Hex(canonicalizeRfc8785(value))}`,
  });
}
export function parsePlatformPermissionPolicy(value: unknown): PlatformPermissionPolicy {
  const r = platformPermissionClosed(value, [
    "profile",
    "actorReference",
    "purposeCode",
    "policyReference",
    "revision",
    "supersedesPolicyReference",
    "content",
    "operationReference",
    "intentDigest",
    "originalCommand",
    "recordedByReference",
    "approvedByReference",
    "approvalEvidenceReference",
    "reasonCode",
    "auditReference",
    "recordedAt",
    "sourceDigest",
    "classification",
  ]);
  const originalCommand = parsePlatformPermissionProvisionCommand(r.originalCommand);
  const parsed = {
    profile: "PlatformPermissionPolicyV1" as const,
    actorReference: parsePlatformPermissionReference(r.actorReference),
    purposeCode: platformPermissionPurpose,
    policyReference: parsePlatformPermissionReference(r.policyReference),
    revision: revision(r.revision),
    supersedesPolicyReference:
      r.supersedesPolicyReference === null
        ? null
        : parsePlatformPermissionReference(r.supersedesPolicyReference),
    content: parsePlatformPermissionContent(r.content),
    operationReference: parsePlatformPermissionReference(r.operationReference),
    intentDigest: digest(r.intentDigest),
    originalCommand,
    recordedByReference: parsePlatformPermissionReference(r.recordedByReference),
    approvedByReference: parsePlatformPermissionReference(r.approvedByReference),
    approvalEvidenceReference: parsePlatformPermissionReference(r.approvalEvidenceReference),
    reasonCode: originalCommand.reasonCode,
    auditReference: parsePlatformPermissionReference(r.auditReference),
    recordedAt: parsePlatformPermissionInstant(r.recordedAt),
    classification: "RestrictedSecurity" as const,
  };
  const head = originalCommand.expectedHead;
  if (
    r.profile !== parsed.profile ||
    r.purposeCode !== platformPermissionPurpose ||
    r.classification !== parsed.classification ||
    r.reasonCode !== parsed.reasonCode ||
    parsed.actorReference !== originalCommand.targetActorReference ||
    parsed.operationReference !== originalCommand.operationReference ||
    parsed.recordedByReference !== originalCommand.recordedByReference ||
    parsed.approvedByReference !== originalCommand.approvedByReference ||
    parsed.approvalEvidenceReference !== originalCommand.approvalEvidenceReference ||
    parsed.revision !== (head?.revision ?? 0) + 1 ||
    parsed.supersedesPolicyReference !== (head?.policyReference ?? null) ||
    canonicalizeRfc8785(parsed.content) !== canonicalizeRfc8785(originalCommand.content) ||
    parsed.intentDigest !== platformPermissionIntentDigest(originalCommand) ||
    digest(r.sourceDigest) !== `sha256:${sha256Hex(canonicalizeRfc8785(parsed))}`
  )
    return platformPermissionFail();
  return Object.freeze({ ...parsed, sourceDigest: r.sourceDigest as string });
}
export function assertPlatformPermissionIdentity(
  value: PlatformPermissionIdentityObservation,
  scope: PlatformPermissionScope,
  at: string,
): void {
  const r = platformPermissionClosed(value, ["session", "recentMfa", "observedAt", "validUntil"]);
  const actor = parsePlatformActor(value.session.actor),
    mfa = parsePlatformSessionMfa(r.recentMfa);
  const observedAt = parsePlatformPermissionInstant(r.observedAt),
    validUntil = parsePlatformPermissionInstant(r.validUntil);
  if (
    actor.actorReference !== scope.actorReference ||
    observedAt > at ||
    at >= validUntil ||
    Date.parse(validUntil) > Date.parse(observedAt) + 5000
  )
    return platformPermissionFail("PLATFORM_PERMISSION_DENIED");
  assertPlatformSessionCurrent(value.session, mfa, at);
}
export function evaluatePlatformPermissionPolicy(
  policy: PlatformPermissionPolicy,
  action: PlatformPermissionAction,
  at: string,
): {
  readonly operate: PlatformPermissionEntry;
  readonly exact: PlatformPermissionEntry;
  readonly validUntil: string;
} | null {
  at = parsePlatformPermissionInstant(at);
  if (at < policy.content.effectiveFrom || at >= policy.content.effectiveUntil) return null;
  const active = policy.content.entries.filter(
    (e) => e.effectiveFrom <= at && at < e.effectiveUntil,
  );
  const actions = new Set<PlatformPermissionAction>(["platform.operate", action]);
  if (active.some((e) => actions.has(e.action) && e.effect === "Deny")) return null;
  const operate = active.find((e) => e.action === "platform.operate" && e.effect === "Allow"),
    exact = active.find((e) => e.action === action && e.effect === "Allow");
  if (!operate || !exact) return null;
  const future = policy.content.entries
    .filter((e) => actions.has(e.action) && e.effectiveFrom > at)
    .map((e) => e.effectiveFrom);
  return Object.freeze({
    operate,
    exact,
    validUntil:
      [
        policy.content.effectiveUntil,
        operate.effectiveUntil,
        exact.effectiveUntil,
        ...future,
      ].sort()[0] ?? policy.content.effectiveUntil,
  });
}
