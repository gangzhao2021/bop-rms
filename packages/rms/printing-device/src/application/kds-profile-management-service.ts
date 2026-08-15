import { validateAuditRecord } from "@bop/audit";
import { revalidateTenantContext } from "@bop/permission";
import {
  parseDeviceCode,
  parseDeviceInstant,
  parseDeviceReference,
  type DeviceScope,
} from "../contracts/device-management.js";
import {
  createKdsProfileRecord,
  type KdsProfileRecord,
} from "../contracts/kds-profile-management.js";
import type {
  KdsProfileCommand,
  KdsProfileManagementPorts,
  KdsProfileOperation,
} from "./ports/kds-profile-management-ports.js";
export type KdsProfileManagementErrorCode =
  | "KDS_PROFILE_INPUT_INVALID"
  | "KDS_PROFILE_PERMISSION_DENIED"
  | "KDS_PROFILE_VERSION_CONFLICT"
  | "KDS_PROFILE_IDEMPOTENCY_CONFLICT"
  | "KDS_PROFILE_LIFECYCLE_CONFLICT"
  | "KDS_PROFILE_ELIGIBILITY_BLOCKED"
  | "KDS_PROFILE_EVIDENCE_REQUIRED"
  | "KDS_PROFILE_DEPENDENCY_UNAVAILABLE";
export class KdsProfileManagementError extends Error {
  constructor(readonly code: KdsProfileManagementErrorCode) {
    super("KDS Profile management operation is unavailable");
    this.name = "KdsProfileManagementError";
  }
}
const fail = (code: KdsProfileManagementErrorCode = "KDS_PROFILE_INPUT_INVALID"): never => {
  throw new KdsProfileManagementError(code);
};
function dependency(error: unknown): never {
  if (error instanceof KdsProfileManagementError) throw error;
  throw new KdsProfileManagementError("KDS_PROFILE_DEPENDENCY_UNAVAILABLE");
}
function exact(value: unknown, fields: readonly string[]): void {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return fail();
}
const permissions: Record<KdsProfileCommand, string> = {
  CreateKdsProfile: "device.kds-profile.create",
  ReviseKdsProfile: "device.kds-profile.revise",
  AssignKdsProfile: "device.kds-profile.assign",
  RecordKdsUat: "device.kds-profile.uat",
  PublishKdsProfile: "device.kds-profile.publish",
  RevokeKdsProfile: "device.kds-profile.revoke",
};
const sameScope = (a: DeviceScope, b: DeviceScope) =>
  a.tenantReference === b.tenantReference &&
  a.brandReference === b.brandReference &&
  a.storeReference === b.storeReference;
function sameExcept(
  a: KdsProfileRecord,
  b: KdsProfileRecord,
  mutable: readonly (keyof KdsProfileRecord)[],
) {
  const ignored = new Set<keyof KdsProfileRecord>(["revision", "updatedAt", ...mutable]);
  return (Object.keys(a) as (keyof KdsProfileRecord)[]).every(
    (key) => ignored.has(key) || JSON.stringify(a[key]) === JSON.stringify(b[key]),
  );
}
async function authorize(
  ports: KdsProfileManagementPorts,
  input: {
    command: KdsProfileCommand;
    operationReference: ReturnType<typeof parseDeviceReference>;
    targetReference: ReturnType<typeof parseDeviceReference>;
    scope: DeviceScope;
    purposeCode: string;
    observedAt: string;
  },
) {
  const evidence = await ports.authorization.authorize(input).catch(dependency);
  if (evidence === null) return fail("KDS_PROFILE_PERMISSION_DENIED");
  try {
    const context = revalidateTenantContext(evidence.tenantContext);
    const audit = validateAuditRecord(evidence.audit, Date.parse(input.observedAt));
    const actor = context.actor.actorReference;
    if (
      actor === null ||
      evidence.tenantReference !== input.scope.tenantReference ||
      String(context.brand.brandReference) !== input.scope.brandReference ||
      String(context.store?.storeReference) !== input.scope.storeReference ||
      evidence.permission.effect !== "Allow" ||
      evidence.permission.action !== permissions[input.command] ||
      evidence.permission.scopeKind !== "Store" ||
      audit.brandId !== input.scope.brandReference ||
      audit.storeId !== input.scope.storeReference ||
      audit.actor.type === "System" ||
      audit.actor.reference !== actor ||
      audit.actionCode !== `KDS_${input.command.toUpperCase()}` ||
      audit.targetType !== "KdsProfile" ||
      audit.targetId !== input.targetReference ||
      audit.occurredAt !== input.observedAt
    )
      throw new Error("denied");
    return { audit, actorReference: parseDeviceReference(actor) };
  } catch {
    return fail("KDS_PROFILE_PERMISSION_DENIED");
  }
}
export function createKdsProfileManagementService(ports: KdsProfileManagementPorts) {
  async function apply(input: {
    readonly command: KdsProfileCommand;
    readonly operationReference: string;
    readonly expectedRevision: number;
    readonly profile: unknown;
    readonly purposeCode: string;
    readonly occurredAt: string;
  }) {
    exact(input, [
      "command",
      "operationReference",
      "expectedRevision",
      "profile",
      "purposeCode",
      "occurredAt",
    ]);
    let profile: KdsProfileRecord;
    let operationReference: ReturnType<typeof parseDeviceReference>;
    let occurredAt: string;
    try {
      profile = createKdsProfileRecord(input.profile);
      operationReference = parseDeviceReference(input.operationReference);
      occurredAt = parseDeviceInstant(input.occurredAt);
      parseDeviceCode(input.purposeCode);
      if (
        !Number.isSafeInteger(input.expectedRevision) ||
        input.expectedRevision < 0 ||
        profile.updatedAt !== occurredAt
      )
        return fail();
    } catch {
      return fail();
    }
    const authorized = await authorize(ports, {
      command: input.command,
      operationReference,
      targetReference: profile.profileReference,
      scope: profile.scope,
      purposeCode: input.purposeCode,
      observedAt: occurredAt,
    });
    const digest = ports.references.hashIntent(JSON.stringify(input));
    const existing = await ports.repository.resolveOperation(operationReference).catch(dependency);
    if (existing !== null) {
      if (!ports.references.equals(existing.intentDigest, digest))
        return fail("KDS_PROFILE_IDEMPOTENCY_CONFLICT");
      return Object.freeze({ status: "AlreadyApplied" as const, profile: existing.profile });
    }
    const latest = await ports.repository.loadLatest(profile.profileReference).catch(dependency);
    if (
      profile.revision !== input.expectedRevision + 1 ||
      (latest === null ? input.expectedRevision !== 0 : latest.revision !== input.expectedRevision)
    )
      return fail("KDS_PROFILE_VERSION_CONFLICT");
    if (input.command === "CreateKdsProfile") {
      if (
        latest !== null ||
        profile.revision !== 1 ||
        profile.lifecycle !== "Draft" ||
        profile.currentVersion.versionNumber !== 1 ||
        profile.assignment !== null ||
        profile.currentUat !== null ||
        profile.createdAt !== occurredAt ||
        profile.createdByReference !== authorized.actorReference
      )
        return fail("KDS_PROFILE_LIFECYCLE_CONFLICT");
    } else {
      if (
        latest === null ||
        !sameScope(latest.scope, profile.scope) ||
        latest.profileReference !== profile.profileReference ||
        latest.createdAt !== profile.createdAt ||
        latest.createdByReference !== profile.createdByReference
      )
        return fail("KDS_PROFILE_LIFECYCLE_CONFLICT");
      if (
        input.command === "ReviseKdsProfile" &&
        (latest.lifecycle !== "Draft" ||
          profile.currentVersion.versionNumber !== latest.currentVersion.versionNumber + 1 ||
          profile.currentVersion.createdAt !== occurredAt ||
          !sameExcept(latest, profile, ["currentVersion", "currentUat"]))
      )
        return fail("KDS_PROFILE_LIFECYCLE_CONFLICT");
      if (input.command === "AssignKdsProfile") {
        if (
          profile.assignment === null ||
          latest.lifecycle !== "Draft" ||
          !sameExcept(latest, profile, ["assignment", "currentUat"])
        )
          return fail("KDS_PROFILE_LIFECYCLE_CONFLICT");
        const eligibility = await ports.eligibility
          .validate({ profile, observedAt: occurredAt })
          .catch(dependency);
        if (!eligibility.eligible || !eligibility.fresh)
          return fail("KDS_PROFILE_ELIGIBILITY_BLOCKED");
      }
      if (input.command === "RecordKdsUat") {
        if (
          profile.currentUat === null ||
          profile.assignment === null ||
          latest.lifecycle !== "Draft" ||
          !sameExcept(latest, profile, ["currentUat"])
        )
          return fail("KDS_PROFILE_LIFECYCLE_CONFLICT");
        if (profile.currentUat.status === "Passed") {
          const evidence = profile.currentUat.evidenceReference;
          if (
            evidence === null ||
            !(await ports.evidence
              .isAccepted({
                evidenceReference: evidence,
                profileReference: profile.profileReference,
                runReference: profile.currentUat.runReference,
                observedAt: occurredAt,
              })
              .catch(dependency))
          )
            return fail("KDS_PROFILE_EVIDENCE_REQUIRED");
        }
      }
      if (input.command === "PublishKdsProfile") {
        if (
          latest.lifecycle !== "Draft" ||
          profile.lifecycle !== "Published" ||
          profile.currentUat?.status !== "Passed" ||
          !sameExcept(latest, profile, ["lifecycle"])
        )
          return fail("KDS_PROFILE_LIFECYCLE_CONFLICT");
        const eligibility = await ports.eligibility
          .validate({ profile, observedAt: occurredAt })
          .catch(dependency);
        if (!eligibility.eligible || !eligibility.fresh || eligibility.activeNamedOperatorSession)
          return fail("KDS_PROFILE_ELIGIBILITY_BLOCKED");
        const evidence = profile.currentUat.evidenceReference;
        if (
          evidence === null ||
          !(await ports.evidence
            .isAccepted({
              evidenceReference: evidence,
              profileReference: profile.profileReference,
              runReference: profile.currentUat.runReference,
              observedAt: occurredAt,
            })
            .catch(dependency))
        )
          return fail("KDS_PROFILE_EVIDENCE_REQUIRED");
      }
      if (
        input.command === "RevokeKdsProfile" &&
        (latest.lifecycle !== "Published" ||
          profile.lifecycle !== "Revoked" ||
          !sameExcept(latest, profile, ["lifecycle"]))
      )
        return fail("KDS_PROFILE_LIFECYCLE_CONFLICT");
    }
    const operation: KdsProfileOperation = Object.freeze({
      command: input.command,
      operationReference,
      intentDigest: digest,
      profile,
    });
    const committed = await ports.repository
      .commit({ operation, expectedRevision: input.expectedRevision, audit: authorized.audit })
      .catch(dependency);
    return Object.freeze({ status: "Applied" as const, profile: committed.profile });
  }
  const invoke =
    (command: KdsProfileCommand) => (input: Omit<Parameters<typeof apply>[0], "command">) =>
      apply({ ...input, command });
  return Object.freeze({
    createProfile: invoke("CreateKdsProfile"),
    reviseProfile: invoke("ReviseKdsProfile"),
    assignProfile: invoke("AssignKdsProfile"),
    recordUat: invoke("RecordKdsUat"),
    publishProfile: invoke("PublishKdsProfile"),
    revokeProfile: invoke("RevokeKdsProfile"),
  });
}
