import {
  createAuthenticationSession,
  parseOpaqueUuidV7,
  readClosedRecord,
  type AuthenticationSession,
} from "@bop/identity";
import { parseBrandReference } from "@bop/tenant";
import {
  membershipBrandDiscoveryInvalid,
  membershipBrandDiscoveryPurpose,
  parseBrandDiscoveryInstant,
  parseMembershipBrandDiscoveryPage,
  parseMembershipBrandDiscoveryRequest,
  type MembershipBrandDiscoveryRequest,
} from "../../contracts/brand-discovery.js";
import type { MembershipReadTransaction } from "./current-membership-store.js";

export interface MembershipBrandDiscoverySourceOptions {
  readonly transaction: MembershipReadTransaction;
  readonly actorReference: string;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly authority: {
    holdUntilTransactionCompletes(
      actual: MembershipReadTransaction,
      request: {
        readonly actorReference: string;
        readonly purposeCode: "BRAND_DISCOVERY";
        readonly observedAt: string;
        readonly validUntil: string;
      },
    ): Promise<{ readonly session: AuthenticationSession; readonly validUntil: string }>;
  };
  readonly registerBeforeCommit: (
    actual: MembershipReadTransaction,
    guard: () => Promise<void>,
    final: () => void,
  ) => Promise<void> | void;
}
const sql =
  "SELECT brand_references,transition_at FROM bop_membership.membership_brand_discovery_read($1::uuid,$2::timestamptz,$3::uuid,$4::integer)";
/** The caller owns COMMIT. Table SHARE freezes existing and inserted Memberships;
 * final reads use current time, and scheduled starts/ends shorten the original
 * lease. Candidates must still undergo current Brand/IAM/Feature admission. */
export function createPostgresMembershipBrandDiscoverySource(
  options: MembershipBrandDiscoverySourceOptions,
) {
  readClosedRecord(options, [
    "transaction",
    "actorReference",
    "clock",
    "originalObservedAt",
    "originalValidUntil",
    "authority",
    "registerBeforeCommit",
  ]);
  readClosedRecord(options.clock, ["now"]);
  readClosedRecord(options.authority, ["holdUntilTransactionCompletes"]);
  const tx = options.transaction,
    queryPort = tx.query,
    clock = options.clock,
    now = clock.now,
    authority = options.authority,
    hold = authority.holdUntilTransactionCompletes,
    register = options.registerBeforeCommit;
  const actor = String(parseOpaqueUuidV7(options.actorReference, "ACTOR_REFERENCE_INVALID")),
    origin = parseBrandDiscoveryInstant(options.originalObservedAt),
    originalUntil = parseBrandDiscoveryInstant(options.originalValidUntil);
  if (
    [queryPort, now, hold, register].some((v) => typeof v !== "function") ||
    originalUntil <= origin ||
    Date.parse(originalUntil) - Date.parse(origin) > 5000
  )
    return membershipBrandDiscoveryInvalid();
  let phase: "Work" | "Checks" | "Final" | "Poison" = "Work",
    busy = false,
    used = false,
    registered = false,
    checked = false,
    guardCalls = 0,
    finalCalls = 0,
    latest = origin,
    deadline = originalUntil,
    sessionPin: string | undefined;
  let request: MembershipBrandDiscoveryRequest | undefined, pinned: string | undefined;
  const fail = (): never => {
    phase = "Poison";
    return membershipBrandDiscoveryInvalid();
  };
  const unchanged = () =>
    options.transaction === tx &&
    tx.query === queryPort &&
    options.actorReference === actor &&
    options.clock === clock &&
    clock.now === now &&
    options.authority === authority &&
    authority.holdUntilTransactionCompletes === hold &&
    options.registerBeforeCommit === register &&
    options.originalObservedAt === origin &&
    options.originalValidUntil === originalUntil;
  function check() {
    try {
      if (phase === "Poison" || phase === "Final" || !unchanged()) return fail();
      const at = parseBrandDiscoveryInstant(now.call(clock));
      if (!unchanged() || at < latest || at >= deadline) return fail();
      latest = at;
      return at;
    } catch {
      return fail();
    }
  }
  function tighten(value: string) {
    const until = parseBrandDiscoveryInstant(value);
    if (until < deadline) deadline = until;
    check();
  }
  async function query(text: string, values: readonly unknown[]) {
    check();
    const result = await queryPort.call(tx, text, values);
    check();
    return result;
  }
  function one(value: unknown) {
    const d =
      value && typeof value === "object"
        ? Object.getOwnPropertyDescriptor(value, "rows")
        : undefined;
    if (
      !d?.enumerable ||
      !("value" in d) ||
      !Array.isArray(d.value) ||
      Object.getPrototypeOf(d.value) !== Array.prototype ||
      d.value.length !== 1 ||
      Reflect.ownKeys(d.value).length !== 2
    )
      return fail();
    const entry = Object.getOwnPropertyDescriptor(d.value, "0");
    if (!entry?.enumerable || !("value" in entry)) return fail();
    return entry.value;
  }
  async function authorize() {
    const observedAt = check(),
      packet = readClosedRecord(
        await hold.call(
          authority,
          tx,
          Object.freeze({
            actorReference: actor,
            purposeCode: membershipBrandDiscoveryPurpose,
            observedAt,
            validUntil: deadline,
          }),
        ),
        ["session", "validUntil"],
      );
    check();
    // The held port returns the normalized public AuthenticationSession shape,
    // while its constructor accepts flattened policy input. Validate both closed
    // records before translating the genuine policy values into that constructor.
    const held = readClosedRecord(packet.session, [
      "sessionReference",
      "actor",
      "status",
      "policy",
      "version",
      "authenticatedAt",
      "createdAt",
      "lastSeenAt",
      "idleExpiresAt",
      "absoluteExpiresAt",
      "rotatedFromSessionReference",
      "revocationReason",
      "revokedAt",
    ]);
    const policy = readClosedRecord(held.policy, [
      "code",
      "maxActiveSessions",
      "idleTimeoutMinutes",
      "absoluteTimeoutMinutes",
    ]);
    const { policy: heldPolicy, ...identityFields } = held;
    void heldPolicy;
    const session = createAuthenticationSession({
        ...identityFields,
        policyCode: policy.code,
        maxActiveSessions: policy.maxActiveSessions,
        idleTimeoutMinutes: policy.idleTimeoutMinutes,
        absoluteTimeoutMinutes: policy.absoluteTimeoutMinutes,
      }),
      at = check(),
      a = session.actor;
    if (
      session.status !== "Active" ||
      a.actorType !== "User" ||
      a.accountKind !== "Workforce" ||
      a.status !== "Active" ||
      String(a.actorReference) !== actor ||
      a.verificationLevel !== "RecentMfa" ||
      a.recentMfaAt === null ||
      String(a.authenticatedAt) > at ||
      String(a.recentMfaAt) > at
    )
      return fail();
    const stable = JSON.stringify(session);
    if (sessionPin !== undefined && stable !== sessionPin) return fail();
    sessionPin = stable;
    tighten(String(packet.validUntil));
    tighten(String(session.idleExpiresAt));
    tighten(String(session.absoluteExpiresAt));
    tighten(new Date(Date.parse(a.recentMfaAt) + 900000).toISOString());
  }
  async function read() {
    if (!request) return fail();
    const observedAt = check(),
      remaining = String(Math.max(1, Date.parse(deadline) - Date.parse(observedAt)));
    await query(
      "SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$1,true)",
      [remaining],
    );
    await query(
      "SELECT set_config('bop.tenant_id','',true),set_config('bop.brand_id','',true),set_config('bop.store_id','',true),set_config('bop.membership_discovery_actor_id',$1,true),set_config('bop.membership_discovery_purpose','BRAND_DISCOVERY',true)",
      [actor],
    );
    const row = readClosedRecord(
      one(await query(sql, [actor, observedAt, request.afterBrandReference, request.limit])),
      ["brand_references", "transition_at"],
    );
    if (
      !Array.isArray(row.brand_references) ||
      Object.getPrototypeOf(row.brand_references) !== Array.prototype ||
      row.brand_references.length > request.limit + 1 ||
      Reflect.ownKeys(row.brand_references).length !== row.brand_references.length + 1
    )
      return fail();
    let previous = request.afterBrandReference;
    const ids = Array.from({ length: row.brand_references.length }, (_, i) => {
      const d = Object.getOwnPropertyDescriptor(row.brand_references, String(i));
      if (!d?.enumerable || !("value" in d)) return fail();
      const id = String(parseBrandReference(d.value));
      if (previous !== null && id <= previous) return fail();
      previous = id;
      return id;
    });
    if (row.transition_at !== null) {
      const transition = parseBrandDiscoveryInstant(row.transition_at);
      if (transition <= observedAt) return fail();
      tighten(transition);
    }
    return ids;
  }
  async function seal() {
    if (registered) return;
    registered = true;
    const result = await register.call(
      options,
      tx,
      async () => {
        if (busy || phase !== "Work" || !used || ++guardCalls !== 1) return fail();
        busy = true;
        phase = "Checks";
        try {
          await authorize();
          if (pinned === undefined || JSON.stringify(await read()) !== pinned) return fail();
          check();
          checked = true;
        } catch {
          return fail();
        } finally {
          busy = false;
        }
      },
      () => {
        if (busy || phase !== "Checks" || !checked || guardCalls !== 1 || ++finalCalls !== 1)
          return fail();
        check();
        phase = "Final";
      },
    );
    if (result !== undefined) return fail();
    check();
  }
  return Object.freeze({
    async holdPage(value: unknown) {
      try {
        if (busy || used || phase !== "Work") return fail();
        busy = true;
        await seal();
        used = true;
        request = parseMembershipBrandDiscoveryRequest(value);
        await authorize();
        const isolation = readClosedRecord(
          one(await query("SELECT current_setting('transaction_isolation') AS isolation", [])),
          ["isolation"],
        );
        if (isolation.isolation !== "read committed") return fail();
        const ids = await read();
        pinned = JSON.stringify(ids);
        const hasMore = ids.length > request.limit,
          brandReferences = ids.slice(0, request.limit);
        return parseMembershipBrandDiscoveryPage({
          profile: "MembershipBrandDiscoveryPageV1",
          actorReference: actor,
          purposeCode: membershipBrandDiscoveryPurpose,
          ...request,
          brandReferences,
          hasMore,
          nextAfterBrandReference: hasMore ? brandReferences.at(-1) : null,
          observedAt: check(),
          validUntil: deadline,
        });
      } catch {
        return fail();
      } finally {
        busy = false;
      }
    },
    assertFinalized() {
      if (phase !== "Final" || !checked || guardCalls !== 1 || finalCalls !== 1) return fail();
    },
  });
}
