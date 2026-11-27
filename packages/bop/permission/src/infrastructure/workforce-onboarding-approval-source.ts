import { Buffer } from "node:buffer";
import { createPublicKey, verify } from "node:crypto";
import { canonicalizeRfc8785 } from "@bop/audit";
import {
  WorkforceOnboardingApprovalError,
  workforceOnboardingApprovalPurpose,
  workforceOnboardingApprovalSigningBytes,
  parseWorkforceOnboardingApproval,
  parseWorkforceOnboardingApprovalExpected,
  parseWorkforceOnboardingApprovalInstant,
  parseWorkforceOnboardingApprovalTrust,
  type WorkforceOnboardingApproval,
  type WorkforceOnboardingApprovalExpected,
} from "../contracts/workforce-onboarding-approval.js";

export interface WorkforceOnboardingApprovalLease {
  readonly approval: WorkforceOnboardingApproval;
  readonly observedAt: string;
  readonly validUntil: string;
  assertCurrent(): Promise<void>;
  /** Final synchronous pre-COMMIT seal after an explicit asynchronous current
   * reread. The owning transaction may finish inside the work callback. */
  assertFinalized(): void;
}
export interface SignedWorkforceOnboardingApprovalSourceOptions {
  readonly clock: { now(): string };
  readonly readApproval: (expected: WorkforceOnboardingApprovalExpected) => Promise<unknown>;
  readonly readTrust: (input: {
    readonly environmentReference: string;
    readonly purposeCode: typeof workforceOnboardingApprovalPurpose;
    readonly observedAt: string;
  }) => Promise<unknown>;
}
const fail = (): never => {
  throw new WorkforceOnboardingApprovalError();
};
function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
    result[field] = descriptor.value;
  }
  return result;
}
/** Verifies concrete Ed25519 signatures against configured, current trust only.
 * No key, account or relationship fact is seeded. Verification binds the
 * exact approved plan only; the executing operator must be authenticated by
 * its genuine Identity source and target qualifications remain independently owned. */
export function createSignedWorkforceOnboardingApprovalSource(
  options: SignedWorkforceOnboardingApprovalSourceOptions,
) {
  record(options, ["clock", "readApproval", "readTrust"]);
  record(options.clock, ["now"]);
  const clock = options.clock,
    nowPort = clock.now,
    approvalPort = options.readApproval,
    trustPort = options.readTrust;
  if (
    typeof nowPort !== "function" ||
    typeof approvalPort !== "function" ||
    typeof trustPort !== "function"
  )
    return fail();
  let phase: "Unused" | "Opening" | "Work" | "Final" = "Unused",
    failed = false,
    reading = false,
    latest: string | undefined,
    deadline: string | undefined;
  const poison = (): never => {
    failed = true;
    return fail();
  };
  function now(): string {
    try {
      const current = record(options, ["clock", "readApproval", "readTrust"]),
        clockFields = record(clock, ["now"]);
      if (
        failed ||
        current.clock !== clock ||
        clockFields.now !== nowPort ||
        current.readApproval !== approvalPort ||
        current.readTrust !== trustPort
      )
        return poison();
      const at = parseWorkforceOnboardingApprovalInstant(nowPort.call(clock));
      if ((latest !== undefined && at < latest) || (deadline !== undefined && at >= deadline))
        return poison();
      latest = at;
      return at;
    } catch {
      return poison();
    }
  }
  return Object.freeze({
    async withApproval<T>(
      rawExpected: unknown,
      work: (lease: WorkforceOnboardingApprovalLease) => Promise<T>,
    ): Promise<T> {
      try {
        if (phase !== "Unused" || typeof work !== "function") return poison();
        phase = "Opening";
        const expected = parseWorkforceOnboardingApprovalExpected(rawExpected),
          observedAt = now();
        deadline = new Date(Date.parse(observedAt) + 5000).toISOString();
        let approvalIdentity: string | undefined,
          keyIdentity: string | undefined,
          currentChecked = false;
        async function read(): Promise<WorkforceOnboardingApproval> {
          if (reading || failed || phase === "Final") return poison();
          reading = true;
          try {
            now();
            const approval = parseWorkforceOnboardingApproval(
              await approvalPort.call(options, expected),
            );
            const at = now();
            const trust = parseWorkforceOnboardingApprovalTrust(
              await trustPort.call(
                options,
                Object.freeze({
                  environmentReference: expected.environmentReference,
                  purposeCode: workforceOnboardingApprovalPurpose,
                  observedAt: at,
                }),
              ),
            );
            const currentAt = now();
            if (
              approval.environmentReference !== expected.environmentReference ||
              approval.operationReference !== expected.operationReference ||
              approval.brandReference !== expected.brandReference ||
              approval.actorReference !== expected.actorReference ||
              approval.membershipReference !== expected.membershipReference ||
              approval.planDigest !== expected.planDigest ||
              approval.operatorReference !== expected.operatorReference ||
              approval.notBefore > currentAt ||
              approval.validUntil <= currentAt ||
              trust.revokedApprovalEvidenceReferences.includes(approval.approvalEvidenceReference)
            )
              return poison();
            const key = trust.keys.find((item) => item.keyReference === approval.keyReference);
            if (
              !key ||
              key.approvedByReference !== approval.approvedByReference ||
              key.environmentReference !== expected.environmentReference ||
              key.purposeCode !== approval.purposeCode ||
              key.notBefore > currentAt ||
              key.validUntil <= currentAt
            )
              return poison();
            const publicKey = createPublicKey({
              key: Buffer.from(key.publicKeySpki, "base64url"),
              format: "der",
              type: "spki",
            });
            if (
              publicKey.asymmetricKeyType !== "ed25519" ||
              publicKey.export({ format: "der", type: "spki" }).toString("base64url") !==
                key.publicKeySpki ||
              !verify(
                null,
                Buffer.from(workforceOnboardingApprovalSigningBytes(approval), "utf8"),
                publicKey,
                Buffer.from(approval.signature, "base64url"),
              )
            )
              return poison();
            const approvalBytes = canonicalizeRfc8785(approval),
              keyBytes = canonicalizeRfc8785(key);
            if (
              (approvalIdentity !== undefined && approvalIdentity !== approvalBytes) ||
              (keyIdentity !== undefined && keyIdentity !== keyBytes)
            )
              return poison();
            approvalIdentity = approvalBytes;
            keyIdentity = keyBytes;
            for (const until of [approval.validUntil, key.validUntil])
              if (deadline === undefined || until < deadline) deadline = until;
            now();
            return approval;
          } catch {
            return poison();
          } finally {
            reading = false;
          }
        }
        const approval = await read();
        phase = "Work";
        const lease: WorkforceOnboardingApprovalLease = Object.freeze({
          approval,
          observedAt,
          get validUntil() {
            if (deadline === undefined) return poison();
            return deadline;
          },
          async assertCurrent(): Promise<void> {
            try {
              if (phase !== "Work") return poison();
              await read();
              currentChecked = true;
            } catch {
              return poison();
            }
          },
          assertFinalized(): void {
            if (failed || reading || phase !== "Work" || !currentChecked) return poison();
            now();
            phase = "Final";
          },
        });
        const result = await work(lease);
        // The actual host seals immediately before COMMIT while work awaits its
        // transaction. Do not reread the clock or files after a committed return.
        const sealed = () => phase === "Final" && !failed && !reading;
        if (!sealed()) return poison();
        return result;
      } catch {
        return poison();
      }
    },
  });
}
