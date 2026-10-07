import { createHash } from "node:crypto";
import { readClosedRecord, parseOpaqueUuidV7 } from "@bop/identity";
import {
  createInitialBrandMembership,
  parseMembershipInstant,
  type Membership,
} from "../../domain/membership.js";
import {
  initialMembershipInvalid as invalid,
  parseInitialBrandMembershipRequest,
  parseInitialBrandMembershipAuthority,
  type InitialBrandMembershipRequest,
  type InitialBrandMembershipAuthority,
} from "../../contracts/initial-brand-membership.js";
export interface InitialBrandMembershipTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export interface InitialBrandMembershipAuditInput {
  readonly auditReference: string;
  readonly operationReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly planDigest: string;
  readonly requestDigest: string;
  readonly approvalEvidenceReference: string;
  readonly purposeCode: "BRAND_INITIAL_PROVISIONING";
  readonly actionCode: "INITIAL_BRAND_MEMBERSHIPS_CREATED";
  readonly membershipReferences: readonly string[];
  readonly occurredAt: string;
}
export interface InitialBrandMembershipStoreOptions {
  readonly transaction: InitialBrandMembershipTransaction;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly auditReference: string;
  readonly authority: {
    /** Actual approval, Identity, Tenant and relationship/invitation holders in
     * this caller transaction. A signature alone never qualifies a relationship. */
    hold(
      tx: InitialBrandMembershipTransaction,
      input: Readonly<{
        request: InitialBrandMembershipRequest;
        requestDigest: string;
        observedAt: string;
        validUntil: string;
      }>,
    ): Promise<InitialBrandMembershipAuthority>;
  };
  readonly appendAudit: (
    tx: InitialBrandMembershipTransaction,
    input: InitialBrandMembershipAuditInput,
  ) => Promise<void>;
  readonly registerBeforeCommit: (
    tx: InitialBrandMembershipTransaction,
    guard: () => Promise<void>,
    final: () => void,
  ) => Promise<void>;
}
function rows(value: unknown, maximum: number): readonly unknown[] {
  if (!value || typeof value !== "object") return invalid();
  const d = Object.getOwnPropertyDescriptor(value, "rows");
  if (
    !d?.enumerable ||
    !("value" in d) ||
    !Array.isArray(d.value) ||
    Object.getPrototypeOf(d.value) !== Array.prototype ||
    d.value.length > maximum ||
    Reflect.ownKeys(d.value).length !== d.value.length + 1
  )
    return invalid();
  return Object.freeze(
    Array.from({ length: d.value.length }, (_, i) => {
      const item = Object.getOwnPropertyDescriptor(d.value, String(i));
      if (!item?.enumerable || !("value" in item)) return invalid();
      return item.value;
    }),
  );
}
/** SHA256 of the fixed closed parser output, not arbitrary JSON canonicalization.
 * The approval's separate whole-plan digest remains owned by Permission. */
export function hashInitialBrandMembershipRequest(value: unknown): string {
  return (
    "sha256:" +
    createHash("sha256")
      .update(JSON.stringify(parseInitialBrandMembershipRequest(value)), "utf8")
      .digest("hex")
  );
}
/** Initialize only. The outer full-operation receipt must arbitrate before this
 * leaf: a replay must never recreate or regrant a revoked Membership. */
export function createPostgresInitialBrandMembershipStore(
  options: InitialBrandMembershipStoreOptions,
) {
  const tx = options.transaction,
    queryPort = tx.query,
    clock = options.clock,
    now = clock.now,
    authority = options.authority,
    hold = authority.hold,
    append = options.appendAudit,
    register = options.registerBeforeCommit,
    origin = parseMembershipInstant(options.originalObservedAt),
    originalUntil = parseMembershipInstant(options.originalValidUntil),
    auditReference = parseOpaqueUuidV7(options.auditReference, "ACTOR_REFERENCE_INVALID");
  if (
    originalUntil <= origin ||
    Date.parse(originalUntil) > Date.parse(origin) + 5000 ||
    [queryPort, now, hold, append, register].some((value) => typeof value !== "function")
  )
    return invalid();
  let phase: "Ready" | "Work" | "Guard" | "Guarded" | "Final" | "Poison" = "Ready",
    busy = false,
    latest: string = origin,
    deadline: string = originalUntil,
    transactionId: string | undefined,
    heldIdentity: string | undefined;
  const poison = (): never => {
    phase = "Poison";
    return invalid();
  };
  const check = () => {
    try {
      const at = parseMembershipInstant(now.call(clock));
      if (
        phase === "Poison" ||
        phase === "Final" ||
        options.transaction !== tx ||
        tx.query !== queryPort ||
        options.clock !== clock ||
        clock.now !== now ||
        options.authority !== authority ||
        authority.hold !== hold ||
        options.appendAudit !== append ||
        options.registerBeforeCommit !== register ||
        options.originalObservedAt !== origin ||
        options.originalValidUntil !== originalUntil ||
        options.auditReference !== auditReference ||
        at < latest ||
        at >= deadline
      )
        return poison();
      latest = at;
      return at;
    } catch {
      return poison();
    }
  };
  const query = async (sql: string, values: readonly unknown[]) => {
    check();
    const answer = await queryPort.call(tx, sql, values);
    check();
    return answer;
  };
  const transaction = async () => {
    const answer = rows(
      await query(
        "SELECT current_setting('transaction_isolation') AS isolation,txid_current()::text AS transaction_id",
        [],
      ),
      1,
    );
    if (answer.length !== 1) return poison();
    const r = readClosedRecord(answer[0], ["isolation", "transaction_id"]);
    if (
      r.isolation !== "read committed" ||
      typeof r.transaction_id !== "string" ||
      !/^[1-9][0-9]*$/u.test(r.transaction_id) ||
      (transactionId !== undefined && transactionId !== r.transaction_id)
    )
      return poison();
    transactionId = r.transaction_id;
  };
  const qualify = async (request: InitialBrandMembershipRequest) => {
    const at = check(),
      answer = await hold.call(
        authority,
        tx,
        Object.freeze({
          request,
          requestDigest: hashInitialBrandMembershipRequest(request),
          observedAt: at,
          validUntil: deadline,
        }),
      );
    const after = check(),
      actual = parseInitialBrandMembershipAuthority(
        answer,
        request,
        origin,
        after,
        hashInitialBrandMembershipRequest(request),
      );
    if (actual.validUntil < deadline) deadline = actual.validUntil;
    for (const [index, member] of actual.members.entries()) {
      const businessEnd = request.members[index]?.effectiveUntil;
      if (!businessEnd) return poison();
      if (businessEnd < deadline) deadline = businessEnd;
      if (
        member.relationshipEffectiveUntil !== null &&
        member.relationshipEffectiveUntil < deadline
      )
        deadline = member.relationshipEffectiveUntil;
    }
    const identity = JSON.stringify({
      ...actual,
      observedAt: undefined,
      validUntil: undefined,
      members: actual.members.map((member) => ({
        ...member,
        account: { ...member.account, observedAt: undefined, validUntil: undefined },
      })),
    });
    if (heldIdentity !== undefined && heldIdentity !== identity) return poison();
    heldIdentity = identity;
    check();
    return actual;
  };
  return Object.freeze({
    async initialize(value: unknown) {
      try {
        if (busy || phase !== "Ready") return poison();
        busy = true;
        phase = "Work";
        let initialized = false;
        // Registration precedes all owning reads/writes. A caught leaf failure
        // must still prevent the outer host from committing earlier work.
        await register(
          tx,
          async () => {
            if (!initialized) return poison();
            await guard();
          },
          () => {
            if (!initialized) return poison();
            final();
          },
        );
        const request = parseInitialBrandMembershipRequest(value);
        check();
        await transaction();
        const actual = await qualify(request);
        await query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
          [request.brandReference],
        );
        // Initial creation is rare. This owning predicate fence prevents a raw
        // concurrent INSERT from adding a second Actor/Brand row after the guard.
        await query("LOCK TABLE bop_membership.membership IN SHARE ROW EXCLUSIVE MODE", []);
        for (const member of [...request.members].sort((a, b) =>
          a.actorReference.localeCompare(b.actorReference),
        ))
          await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            `InitialBrandMembership:${request.brandReference}:${member.actorReference}`,
          ]);
        const ids = request.members.map((m) => m.membershipReference),
          actors = request.members.map((m) => m.actorReference);
        if (
          rows(
            await query(
              "SELECT membership_id FROM bop_membership.membership WHERE (brand_id=$1 AND actor_id=ANY($2::uuid[])) OR membership_id=ANY($3::uuid[]) LIMIT 1 FOR UPDATE",
              [request.brandReference, actors, ids],
            ),
            1,
          ).length
        )
          return poison();
        const memberships = Object.freeze(
          actual.members.map((member, index) => {
            const wanted = request.members[index];
            if (!wanted) return poison();
            return createInitialBrandMembership(
              {
                membershipReference: member.membershipReference,
                actorReference: member.account.actorReference,
                brandReference: request.brandReference,
                workforceRelationshipReference: member.workforceRelationshipReference,
                lifecycle: "Active",
                effectiveFrom: origin,
                effectiveUntil: wanted.effectiveUntil,
                version: 1,
                createdAt: origin,
                updatedAt: origin,
              },
              member.account,
              origin,
            );
          }),
        );
        for (const member of memberships) {
          const result = rows(
            await query(
              "INSERT INTO bop_membership.membership(membership_id,actor_id,brand_id,workforce_relationship_reference,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,$4,'Active',$5,$6,1,$5,$5) RETURNING membership_id",
              [
                member.membershipReference,
                member.actorReference,
                member.brandReference,
                member.workforceRelationshipReference,
                origin,
                member.effectiveUntil,
              ],
            ),
            1,
          );
          if (
            result.length !== 1 ||
            readClosedRecord(result[0], ["membership_id"]).membership_id !==
              member.membershipReference
          )
            return poison();
        }
        const audit = Object.freeze({
          auditReference,
          operationReference: request.operationReference,
          brandReference: request.brandReference,
          actorReference: request.operatorReference,
          planDigest: request.planDigest,
          requestDigest: hashInitialBrandMembershipRequest(request),
          approvalEvidenceReference: request.approvalEvidenceReference,
          purposeCode: "BRAND_INITIAL_PROVISIONING" as const,
          actionCode: "INITIAL_BRAND_MEMBERSHIPS_CREATED" as const,
          membershipReferences: Object.freeze(ids),
          occurredAt: origin,
        });
        check();
        if ((await append(tx, audit)) !== undefined) return poison();
        check();
        const guard = async () => {
          try {
            if (busy || (phase !== "Work" && phase !== "Guarded")) return poison();
            busy = true;
            phase = "Guard";
            await transaction();
            await qualify(request);
            await query(
              "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
              [request.brandReference],
            );
            const records = rows(
              await query(
                `SELECT membership_id,actor_id,brand_id,workforce_relationship_reference,lifecycle,version,
              to_char(effective_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') effective_from,
              to_char(effective_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') effective_until,
              to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') created_at,
              to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') updated_at,
              effective_from=date_trunc('milliseconds',effective_from) AND effective_until=date_trunc('milliseconds',effective_until)
                AND created_at=date_trunc('milliseconds',created_at) AND updated_at=date_trunc('milliseconds',updated_at) precise
              FROM bop_membership.membership WHERE brand_id=$1 AND (membership_id=ANY($2::uuid[]) OR actor_id=ANY($3::uuid[])) ORDER BY membership_id FOR SHARE`,
                [request.brandReference, ids, actors],
              ),
              20,
            );
            if (records.length !== memberships.length) return poison();
            const found = new Set<string>();
            for (const value of records) {
              const r = readClosedRecord(value, [
                "membership_id",
                "actor_id",
                "brand_id",
                "workforce_relationship_reference",
                "lifecycle",
                "version",
                "effective_from",
                "effective_until",
                "created_at",
                "updated_at",
                "precise",
              ]);
              const index = memberships.findIndex(
                  (member) => member.membershipReference === r.membership_id,
                ),
                account = actual.members[index]?.account;
              if (!account || r.precise !== true || found.has(String(r.membership_id)))
                return poison();
              const stored: Membership = createInitialBrandMembership(
                {
                  membershipReference: r.membership_id,
                  actorReference: r.actor_id,
                  brandReference: r.brand_id,
                  workforceRelationshipReference: r.workforce_relationship_reference,
                  lifecycle: r.lifecycle,
                  version: r.version,
                  effectiveFrom: r.effective_from,
                  effectiveUntil: r.effective_until,
                  createdAt: r.created_at,
                  updatedAt: r.updated_at,
                },
                account,
                origin,
              );
              if (JSON.stringify(stored) !== JSON.stringify(memberships[index])) return poison();
              found.add(stored.membershipReference);
            }
            check();
            phase = "Guarded";
          } catch {
            return poison();
          } finally {
            busy = false;
          }
        };
        const final = () => {
          if (busy || phase !== "Guarded") return poison();
          check();
          phase = "Final";
        };
        initialized = true;
        busy = false;
        check();
        return Object.freeze({
          profile: "InitialBrandMembershipResultV1" as const,
          request,
          requestDigest: hashInitialBrandMembershipRequest(request),
          memberships,
          auditReference,
          occurredAt: origin,
        });
      } catch {
        return poison();
      } finally {
        busy = false;
      }
    },
    assertFinalized() {
      if (phase !== "Final" || busy) return poison();
      return auditReference;
    },
  });
}
