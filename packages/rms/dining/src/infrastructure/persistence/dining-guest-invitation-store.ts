import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import {
  parseDiningJoinCapability,
  parseDiningJoinHumanCode,
  parseDiningJoinInvitationCredential,
  parsePublicCapabilityReference,
  regenerateDiningJoinCapability,
  diningJoinMaximumLifetimeMs,
  type DiningJoinCapability,
  type DiningJoinHumanCode,
  type DiningJoinInvitationCredential,
} from "@bop/public-capability";
import {
  DiningSessionError,
  parseDiningHash,
  parseDiningInstant,
  parseDiningReference,
  parseDiningSession,
  type DiningInstant,
} from "../../domain/dining-session.js";
import {
  diningGuestInvitationAvailableAt,
  diningGuestInvitationIntent,
  evaluateDiningGuestInvitationAuthority,
  evaluateDiningGuestInvitationBudget,
  parseDiningGuestInvitationCommand,
  type DiningGuestInvitationCommand,
  type DiningGuestInvitationRefusal,
} from "../../domain/dining-guest-invitation.js";
import { captureSessionData } from "../../application/dining-session-snapshot.js";
import type { DiningCredentialPort } from "../../application/ports/dining-session-ports.js";
import {
  createPostgresDiningParticipantFence,
  createPostgresDiningParticipationStore,
} from "./dining-participation-store.js";
import type {
  DiningTableStoreScope,
  DiningTableTransaction,
  DiningTableTransactionRunner,
} from "./dining-table-store.js";

export type DiningGuestInvitationIssueResult =
  | {
      readonly status: "Issued";
      readonly capability: DiningJoinCapability;
      readonly joinCredential: DiningJoinInvitationCredential | DiningJoinHumanCode;
    }
  /** Replay of a committed operation: the code itself is never stored, so it cannot be shown again. */
  | { readonly status: "AlreadyApplied"; readonly capability: DiningJoinCapability }
  | {
      readonly status: "Refused";
      readonly reason: DiningGuestInvitationRefusal;
      readonly retryAt: DiningInstant | null;
    };

export interface DiningGuestInvitationAuditInput {
  readonly command: DiningGuestInvitationCommand;
  readonly tableReference: string;
  readonly capabilityReference: string;
}

export interface DiningGuestInvitationStoreOptions {
  readonly scope: DiningTableStoreScope;
  readonly credentials: Pick<
    DiningCredentialPort,
    | "generateReference"
    | "generateJoinCredential"
    | "hashJoinCredential"
    | "hashOperationIntent"
    | "equals"
  >;
  readonly pepperVersion: number;
  now(): string;
  /**
   * Current Guest identity and Dining binding on this same transaction, proving that the caller
   * is this command's own guest session for this Session and participant. Called before and
   * after the owner writes; anything but `true` rolls the transaction back.
   */
  authorize(tx: DiningTableTransaction, command: DiningGuestInvitationCommand): Promise<boolean>;
  audit(input: DiningGuestInvitationAuditInput): unknown;
}

const fail = (): never => {
  throw new DiningSessionError("DINING_SESSION_DEPENDENCY_UNAVAILABLE");
};
function rows(value: unknown, maximum = 1): readonly Record<string, unknown>[] {
  if (value === null || typeof value !== "object") return fail();
  const descriptor = Object.getOwnPropertyDescriptor(value, "rows");
  if (!descriptor || !("value" in descriptor)) return fail();
  const copied = captureSessionData(descriptor.value);
  if (!Array.isArray(copied) || copied.length > maximum) return fail();
  return copied as Record<string, unknown>[];
}
function changed(value: unknown) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getOwnPropertyDescriptor(value, "rowCount")?.value !== 1
  )
    return fail();
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * DEC-DINING-GUEST-INVITATION: the Host's own phone issues the Session's next one-time join code.
 * Owns its transaction. Lock order: Guest identity (in `authorize`) -> Dining Table (advisory and
 * row) -> Session -> participant -> current code, as Join and staff regeneration take them.
 */
export function createPostgresDiningGuestInvitationStore(
  runner: DiningTableTransactionRunner,
  options: DiningGuestInvitationStoreOptions,
) {
  const tenant = parseDiningReference(options.scope.tenantReference);
  const brand = parseDiningReference(options.scope.brandReference);
  const store = parseDiningReference(options.scope.storeReference);
  if (!Number.isSafeInteger(options.pepperVersion) || options.pepperVersion < 1) return fail();
  const { credentials } = options;
  const scope = { tenantReference: tenant, brandReference: brand, storeReference: store };
  const command = (value: unknown) => {
    const parsed = parseDiningGuestInvitationCommand(value);
    if (
      parsed.tenantReference !== tenant ||
      parsed.brandReference !== brand ||
      parsed.storeReference !== store
    )
      throw new DiningSessionError("DINING_SESSION_PERMISSION_DENIED");
    return parsed;
  };
  const context = (tx: DiningTableTransaction) =>
    tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
  const history = async (tx: DiningTableTransaction, accepted: DiningGuestInvitationCommand) =>
    rows(
      await tx.query(
        "SELECT to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS at FROM rms_dining.dining_guest_invitation_operation WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 AND occurred_at>$5::timestamptz-interval '10 minutes' AND occurred_at<=$5::timestamptz ORDER BY occurred_at LIMIT 100",
        [tenant, brand, store, accepted.diningSessionReference, accepted.observedAt],
      ),
      100,
    ).map((row) => {
      if (typeof row.at !== "string") return fail();
      return row.at;
    });
  return Object.freeze({
    /** Whether this guest may invite now: the Host of an Active Session (no write, no lock). */
    async eligibility(value: unknown): Promise<"Allowed" | "NotHost"> {
      const accepted = command(value);
      return runner.run(async (tx) => {
        if ((await options.authorize(tx, accepted)) !== true)
          throw new DiningSessionError("DINING_SESSION_PERMISSION_DENIED");
        const current = await createPostgresDiningParticipationStore(
          { run: (work) => work(tx) },
          scope,
        ).readCurrent({
          brandReference: brand,
          storeReference: store,
          diningSessionReference: accepted.diningSessionReference,
          participantReference: accepted.participantReference,
          observedAt: accepted.observedAt,
        });
        if (current === null) return "NotHost";
        return evaluateDiningGuestInvitationAuthority({
          command: accepted,
          session: current.session,
          participantStatus: current.participant.status,
        });
      });
    },

    async issue(value: unknown): Promise<DiningGuestInvitationIssueResult> {
      const accepted = command(value);
      const intent = parseDiningHash(
        credentials.hashOperationIntent(diningGuestInvitationIntent(accepted)),
      );
      let previous: string = accepted.observedAt;
      const tick = () => {
        const at = parseDiningInstant(options.now());
        if (at < previous) return fail();
        previous = at;
        return at;
      };
      try {
        return await runner.run(async (tx) => {
          const authorize = async () => {
            tick();
            if ((await options.authorize(tx, accepted)) !== true)
              throw new DiningSessionError("DINING_SESSION_PERMISSION_DENIED");
            tick();
          };
          await authorize();
          await context(tx);
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            `DiningGuestInvitation:${tenant}:${brand}:${store}:${accepted.operationReference}`,
          ]);
          const prior = rows(
            await tx.query(
              "SELECT record_json AS record, intent_hash AS intent FROM rms_dining.dining_guest_invitation_operation WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4",
              [tenant, brand, store, accepted.operationReference],
            ),
          )[0];
          if (prior) {
            const record = prior.record as Record<string, unknown> | null;
            if (
              typeof prior.intent !== "string" ||
              credentials.equals(parseDiningHash(prior.intent), intent) !== true ||
              record === null ||
              typeof record !== "object" ||
              record.diningSessionReference !== accepted.diningSessionReference ||
              record.participantReference !== accepted.participantReference
            )
              throw new DiningSessionError("DINING_SESSION_IDEMPOTENCY_CONFLICT");
            const capability = parseDiningJoinCapability(record.capability);
            await authorize();
            return Object.freeze({ status: "AlreadyApplied" as const, capability });
          }
          // Observe the Session's Table only to take the same advisory Table lock as Join.
          const located = rows(
            await tx.query(
              "SELECT table_id FROM rms_dining.dining_session WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4",
              [tenant, brand, store, accepted.diningSessionReference],
            ),
          )[0];
          if (!located) return refused("NotHost", null);
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            `DiningTable:${tenant}:${brand}:${store}:${parseDiningReference(located.table_id)}`,
          ]);
          const current = await createPostgresDiningParticipantFence(
            { run: (work) => work(tx) },
            scope,
          ).readCurrent({
            brandReference: brand,
            storeReference: store,
            diningSessionReference: accepted.diningSessionReference,
            participantReference: accepted.participantReference,
            observedAt: accepted.observedAt,
          });
          if (current === null) return refused("NotHost", null);
          const session = parseDiningSession(current.session);
          if (
            evaluateDiningGuestInvitationAuthority({
              command: accepted,
              session,
              participantStatus: current.participant.status,
            }) !== "Allowed"
          )
            return refused("NotHost", null);
          const issuedAt = await history(tx, accepted);
          if (
            evaluateDiningGuestInvitationBudget({ issuedAt, observedAt: accepted.observedAt }) !==
            "Admitted"
          )
            return refused(
              "TooManyInvitations",
              diningGuestInvitationAvailableAt({ issuedAt, observedAt: accepted.observedAt }),
            );
          const caps = rows(
            await tx.query(
              "SELECT capability_snapshot AS capability FROM rms_dining.dining_join_capability WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 ORDER BY (capability_snapshot->>'generation')::numeric DESC LIMIT 1 FOR UPDATE",
              [tenant, brand, store, accepted.diningSessionReference],
            ),
          );
          if (!caps.length) return fail();
          const latest = parseDiningJoinCapability(caps[0]?.capability);
          if (
            String(latest.storeReference) !== store ||
            String(latest.diningSessionReference) !== session.diningSessionReference
          )
            return fail();
          // A moved Table needs its next code from staff (reissue checks the committed Move).
          if (
            String(latest.tableReference) !== session.tableReference ||
            latest.assignmentVersion !== session.tableAssignmentVersion
          )
            return refused("TableChanged", null);
          const observedAt = accepted.observedAt;
          if (String(latest.issuedAt) > observedAt) return fail();
          const raw = credentials.generateJoinCredential(latest.kind);
          const joinCredential =
            latest.kind === "Invitation"
              ? parseDiningJoinInvitationCredential(raw)
              : parseDiningJoinHumanCode(raw);
          const replacement = parseDiningJoinCapability({
            ...latest,
            capabilityReference: parsePublicCapabilityReference(
              credentials.generateReference("JoinCapability"),
            ),
            selectorHash: credentials.hashJoinCredential(latest.kind, joinCredential),
            pepperVersion: options.pepperVersion,
            generation: latest.generation + 1,
            status: "Active",
            version: 1,
            issuedAt: observedAt,
            expiresAt: new Date(Date.parse(observedAt) + diningJoinMaximumLifetimeMs).toISOString(),
            consumedAt: null,
            revokedAt: null,
          });
          const transition = regenerateDiningJoinCapability({
            previous: latest,
            replacement,
            observedAt,
          });
          if (!same(transition.current, replacement)) return fail();
          const audit = validateAuditRecord(
            options.audit({
              command: accepted,
              tableReference: session.tableReference,
              capabilityReference: replacement.capabilityReference,
            }),
            Date.parse(tick()),
          );
          if (
            audit.brandId !== brand ||
            audit.storeId !== store ||
            audit.actor.type !== "System" ||
            audit.sourceChannel !== "CUSTOMER_PWA" ||
            audit.actionCode !== "DINING_JOIN_INVITATION_ISSUE" ||
            audit.targetType !== "DiningTable" ||
            audit.targetId !== session.tableReference ||
            audit.correlationId !== accepted.operationReference ||
            audit.occurredAt !== observedAt ||
            Object.keys(audit.beforeSummary ?? {}).length !== 0 ||
            Object.keys(audit.afterSummary ?? {}).length !== 0
          )
            return fail();
          if (latest.status === "Active")
            changed(
              await tx.query(
                "UPDATE rms_dining.dining_join_capability SET version=$6,status=$7,capability_snapshot=$8::jsonb WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND capability_id=$4 AND version=$5",
                [
                  tenant,
                  brand,
                  store,
                  latest.capabilityReference,
                  latest.version,
                  transition.previous.version,
                  transition.previous.status,
                  JSON.stringify(transition.previous),
                ],
              ),
            );
          changed(
            await tx.query(
              "INSERT INTO rms_dining.dining_join_capability (capability_id,tenant_id,brand_id,store_id,session_id,version,status,capability_snapshot) VALUES ($1,$2,$3,$4,$5,1,'Active',$6::jsonb)",
              [
                replacement.capabilityReference,
                tenant,
                brand,
                store,
                session.diningSessionReference,
                JSON.stringify(replacement),
              ],
            ),
          );
          const record = {
            operationReference: accepted.operationReference,
            diningSessionReference: accepted.diningSessionReference,
            participantReference: accepted.participantReference,
            capability: replacement,
          };
          changed(
            await tx.query(
              "INSERT INTO rms_dining.dining_guest_invitation_operation (operation_id,tenant_id,brand_id,store_id,session_id,participant_id,capability_id,intent_hash,occurred_at,record_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)",
              [
                accepted.operationReference,
                tenant,
                brand,
                store,
                accepted.diningSessionReference,
                accepted.participantReference,
                replacement.capabilityReference,
                intent,
                observedAt,
                JSON.stringify(record),
              ],
            ),
          );
          await appendAuditRecordInTransaction(tx, audit);
          await authorize();
          return Object.freeze({
            status: "Issued" as const,
            capability: replacement,
            joinCredential,
          });
        });
      } catch (error) {
        if (
          error instanceof DiningSessionError &&
          [
            "DINING_SESSION_PERMISSION_DENIED",
            "DINING_SESSION_IDEMPOTENCY_CONFLICT",
            "DINING_SESSION_INPUT_INVALID",
          ].includes(error.code)
        )
          throw new DiningSessionError(error.code);
        return fail();
      }
    },
  });
}

function refused(
  reason: DiningGuestInvitationRefusal,
  retryAt: DiningInstant | null,
): DiningGuestInvitationIssueResult {
  return Object.freeze({ status: "Refused" as const, reason, retryAt });
}
