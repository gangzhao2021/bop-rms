import { appendAuditRecordInTransaction } from "@bop/audit";
import {
  parseCanonicalInstant,
  parseOpaqueUuidV7,
  readClosedRecord,
} from "../../contracts/identity-actor.js";

/**
 * WP-2423 Q5 (DEC-REFUND-ESCALATION-PILOT): Identity owner of the append-only MFA step-up record.
 * A staff member re-verifies a second factor at a Store before a sensitive action. The verifier is
 * a port (pilot: TEST-ONLY TOTP; later the Cognito re-authentication), so this record never sees a
 * secret; the submitted code is passed to the verifier only and is never stored, logged or audited.
 * Caller authorization must bind the actor to the current authenticated session and Store.
 */
interface Transaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export const workforceStepUpRecencyMilliseconds = 15 * 60 * 1000;
const failureLimit = 5;
const failureWindowMilliseconds = 15 * 60 * 1000;
const methods = ["InternalTestTotp"] as const;
export type WorkforceStepUpMethod = (typeof methods)[number];
export type WorkforceStepUpResult =
  | {
      readonly status: "Verified";
      readonly stepUpReference: string;
      readonly verifiedAt: string;
      readonly validUntil: string;
    }
  | { readonly status: "Rejected"; readonly reason: "CodeMismatch" | "CodeReused" }
  | { readonly status: "Locked"; readonly retryAfterSeconds: number };
export class WorkforceStepUpError extends Error {
  constructor(readonly code: "WORKFORCE_STEP_UP_DENIED" | "WORKFORCE_STEP_UP_UNAVAILABLE") {
    super(code);
    this.name = "WorkforceStepUpError";
  }
}
const denied = (): never => {
  throw new WorkforceStepUpError("WORKFORCE_STEP_UP_DENIED");
};
const unavailable = (): never => {
  throw new WorkforceStepUpError("WORKFORCE_STEP_UP_UNAVAILABLE");
};
function rows(result: unknown): readonly Record<string, unknown>[] {
  if (result === null || typeof result !== "object") return unavailable();
  const descriptor = Object.getOwnPropertyDescriptor(result, "rows");
  if (!descriptor || !("value" in descriptor) || !Array.isArray(descriptor.value))
    return unavailable();
  return descriptor.value as readonly Record<string, unknown>[];
}
function instant(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return unavailable();
  return parseCanonicalInstant(value.toISOString());
}
const ref = (value: unknown) => String(parseOpaqueUuidV7(value, "ACTOR_REFERENCE_INVALID"));
async function setScope(tx: Transaction, brandReference: string, storeReference: string) {
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brandReference,
    storeReference,
  ]);
}

export function createPostgresWorkforceMfaStepUpStore(options: {
  readonly method: WorkforceStepUpMethod;
  /** Checks the code for the actor at the database time. null: mismatch. Throws: not set up. */
  verify(input: {
    readonly actorReference: string;
    readonly code: string;
    readonly atMilliseconds: number;
  }): Promise<{ readonly timeStep: number } | null>;
  authorize(
    tx: Transaction,
    query: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly actorReference: string;
      readonly sessionReference: string;
    },
  ): Promise<boolean>;
  retentionPolicyCode: string;
  retentionPolicyVersion: number;
}) {
  if (!methods.includes(options.method)) return unavailable();
  return async (tx: Transaction, value: unknown): Promise<WorkforceStepUpResult> => {
    const raw = readClosedRecord(value, [
      "brandReference",
      "storeReference",
      "actorReference",
      "sessionReference",
      "stepUpReference",
      "auditReference",
      "purposeCode",
      "code",
    ]);
    const query = {
      brandReference: ref(raw.brandReference),
      storeReference: ref(raw.storeReference),
      actorReference: ref(raw.actorReference),
      sessionReference: ref(raw.sessionReference),
    };
    const stepUpReference = ref(raw.stepUpReference),
      auditReference = ref(raw.auditReference);
    if (typeof raw.purposeCode !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(raw.purposeCode))
      return denied();
    const purposeCode = raw.purposeCode;
    // A malformed code is an ordinary mismatch (counted), never echoed.
    const code = typeof raw.code === "string" && /^[0-9]{6}$/u.test(raw.code) ? raw.code : null;
    const authorize = async () => {
      if ((await options.authorize(tx, query)) !== true) return denied();
    };
    await authorize();
    await setScope(tx, query.brandReference, query.storeReference);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "WorkforceMfaStepUp:" + query.actorReference,
    ]);
    const clock = rows(
      await tx.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS now", []),
    );
    const attemptedAt = instant(clock[0]?.now);
    const at = Date.parse(attemptedAt);
    // Failed attempts since the later of the window start and the last success bound new tries.
    const recent = rows(
      await tx.query(
        "SELECT outcome,attempted_at FROM bop_identity.workforce_mfa_step_up WHERE brand_id=$1 AND store_id=$2 AND actor_id=$3 AND attempted_at>$4 ORDER BY attempted_at DESC LIMIT 50",
        [
          query.brandReference,
          query.storeReference,
          query.actorReference,
          new Date(at - failureWindowMilliseconds).toISOString(),
        ],
      ),
    );
    const failures: number[] = [];
    for (const row of recent) {
      if (row.outcome === "Verified") break;
      if (row.outcome !== "Rejected") return unavailable();
      failures.push(Date.parse(instant(row.attempted_at)));
    }
    if (failures.length >= failureLimit) {
      const oldest = failures[failureLimit - 1] ?? at;
      await authorize();
      return Object.freeze({
        status: "Locked" as const,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + failureWindowMilliseconds - at) / 1000)),
      });
    }
    let matched: { readonly timeStep: number } | null = null;
    if (code !== null) {
      try {
        matched = await options.verify({
          actorReference: query.actorReference,
          code,
          atMilliseconds: at,
        });
      } catch {
        return unavailable();
      }
      if (
        matched !== null &&
        (typeof matched !== "object" ||
          !Number.isSafeInteger(matched.timeStep) ||
          matched.timeStep < 0)
      )
        return unavailable();
    }
    const audit = (outcome: "Verified" | "Rejected") => ({
      auditId: auditReference,
      brandId: query.brandReference,
      storeId: query.storeReference,
      actor: { type: "User" as const, reference: query.actorReference },
      actionCode:
        outcome === "Verified" ? "IDENTITY_MFA_STEP_UP_VERIFIED" : "IDENTITY_MFA_STEP_UP_REJECTED",
      targetType: "WorkforceMfaStepUp",
      targetId: stepUpReference,
      reasonCode: purposeCode,
      correlationId: query.sessionReference,
      occurredAt: attemptedAt,
      sourceChannel: "MERCHANT_WEB",
      dataClassification: "Restricted" as const,
      retentionPolicyCode: options.retentionPolicyCode,
      retentionPolicyVersion: options.retentionPolicyVersion,
    });
    const insert =
      "INSERT INTO bop_identity.workforce_mfa_step_up (step_up_id,brand_id,store_id,actor_id,session_id,method,purpose_code,outcome,rejection_reason,time_step,attempted_at,audit_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)";
    const values = (
      outcome: "Verified" | "Rejected",
      reason: "CodeMismatch" | "CodeReused" | null,
    ) => [
      stepUpReference,
      query.brandReference,
      query.storeReference,
      query.actorReference,
      query.sessionReference,
      options.method,
      purposeCode,
      outcome,
      reason,
      outcome === "Verified" ? matched?.timeStep : null,
      attemptedAt,
      auditReference,
    ];
    const reject = async (reason: "CodeMismatch" | "CodeReused") => {
      await tx.query(insert, values("Rejected", reason));
      await appendAuditRecordInTransaction(tx, audit("Rejected"));
      await authorize();
      return Object.freeze({ status: "Rejected" as const, reason });
    };
    if (matched === null) return reject("CodeMismatch");
    // The single-use index spans Stores this session cannot read; a reused step fails the insert.
    await tx.query("SAVEPOINT workforce_mfa_step_up_accept", []);
    try {
      await tx.query(insert, values("Verified", null));
      await tx.query("RELEASE SAVEPOINT workforce_mfa_step_up_accept", []);
    } catch (error) {
      await tx.query("ROLLBACK TO SAVEPOINT workforce_mfa_step_up_accept", []);
      await tx.query("RELEASE SAVEPOINT workforce_mfa_step_up_accept", []);
      const descriptor =
        error !== null && typeof error === "object"
          ? Object.getOwnPropertyDescriptor(error, "code")
          : undefined;
      if (descriptor && "value" in descriptor && descriptor.value === "23505")
        return reject("CodeReused");
      return unavailable();
    }
    await appendAuditRecordInTransaction(tx, audit("Verified"));
    await authorize();
    return Object.freeze({
      status: "Verified" as const,
      stepUpReference,
      verifiedAt: attemptedAt,
      validUntil: new Date(at + workforceStepUpRecencyMilliseconds).toISOString(),
    });
  };
}

/** Latest verified step-up of one actor at this Store no later than observedAt, or null.
 * Recency policy (for example the refund 15-minute rule) belongs to the caller. */
export function createPostgresLatestWorkforceStepUpSource(options: {
  authorize(
    tx: Transaction,
    query: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly actorReference: string;
      readonly observedAt: string;
    },
  ): Promise<boolean>;
}) {
  return async (tx: Transaction, value: unknown): Promise<string | null> => {
    const raw = readClosedRecord(value, [
      "brandReference",
      "storeReference",
      "actorReference",
      "observedAt",
    ]);
    const query = {
      brandReference: ref(raw.brandReference),
      storeReference: ref(raw.storeReference),
      actorReference: ref(raw.actorReference),
      observedAt: parseCanonicalInstant(raw.observedAt),
    };
    const authorize = async () => {
      if ((await options.authorize(tx, query)) !== true) return denied();
    };
    await authorize();
    await setScope(tx, query.brandReference, query.storeReference);
    const found = rows(
      await tx.query(
        "SELECT max(attempted_at) AS verified_at FROM bop_identity.workforce_mfa_step_up WHERE brand_id=$1 AND store_id=$2 AND actor_id=$3 AND outcome='Verified' AND attempted_at<=$4",
        [query.brandReference, query.storeReference, query.actorReference, query.observedAt],
      ),
    );
    if (found.length !== 1) return unavailable();
    const latest = found[0]?.verified_at;
    const result = latest === null || latest === undefined ? null : instant(latest);
    await authorize();
    return result;
  };
}

/** Most recent second-factor verification: the enrollment verification (when currently
 * TotpVerified) or the latest verified step-up. A step-up is itself an evidenced TOTP check of the
 * actor's registered factor by Identity, so it counts whatever the enrollment status, except one
 * made before a factor reset (reset voids earlier verifications). */
export function resolveRecentWorkforceMfaAt(input: {
  readonly status: string;
  readonly verifiedAt: string | null;
  readonly resetAt: string | null;
  readonly latestStepUpAt: string | null;
}): string | null {
  const candidates: string[] = [];
  if (input.status === "TotpVerified" && input.verifiedAt !== null)
    candidates.push(input.verifiedAt);
  if (
    input.latestStepUpAt !== null &&
    (input.resetAt === null || input.latestStepUpAt > input.resetAt)
  )
    candidates.push(input.latestStepUpAt);
  return candidates.sort().at(-1) ?? null;
}
