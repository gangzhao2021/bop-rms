import {
  parseBrandReference,
  parseCanonicalInstant,
  organizationLifecycles,
} from "../../domain/brand-store.js";
import { parsePlatformTenantReference } from "../../contracts/platform-tenant-administration.js";
import { validateBrandStoreTopologyDraftStores } from "../../contracts/brand-store-topology.js";
import {
  parseTenantStoreReferenceSnapshot,
  type TenantStoreReferenceSnapshot,
} from "../../contracts/store-reference-source.js";
import {
  BrandStoreTopologyError,
  parseBrandStoreTopologySave,
  parseBrandStoreTopologyResolve,
  parseBrandStoreTopologyDraftRevision,
  parseBrandStoreTopologyOperationReceipt,
  parseBrandStoreTopologyCurrent,
  type BrandStoreTopologyActorScope,
  type BrandStoreTopologySave,
  type BrandStoreTopologyResolve,
  type BrandStoreTopologyDraftRevision,
  type BrandStoreTopologyOperationReceipt,
} from "../../contracts/brand-store-topology-operation.js";
export interface BrandStoreTopologyDraftTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export const brandStoreTopologyDraftRequiredFields = Object.freeze([
  "scope",
  "brandIdentity",
  "draft",
  "selectors",
  "assignments",
  "revision",
  "originalOperation",
  "audit",
  "storeReferences",
] as const);
type Original = BrandStoreTopologySave | BrandStoreTopologyResolve;
type Mode = "Read" | "Save" | "Resolve";
export interface BrandStoreTopologyDraftStoreOptions extends BrandStoreTopologyActorScope {
  readonly transaction: BrandStoreTopologyDraftTransaction;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly registerBeforeCommit: (
    tx: BrandStoreTopologyDraftTransaction,
    guard: () => Promise<void>,
    final: () => void,
  ) => Promise<void> | void;
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: BrandStoreTopologyDraftTransaction,
      input: Readonly<
        BrandStoreTopologyActorScope & {
          permission: "organization.manage";
          purposeCode: "BRAND_STORE_TOPOLOGY_DRAFT";
          mode: Mode;
          requiredFields: typeof brandStoreTopologyDraftRequiredFields;
          command: Original | null;
          observedAt: string;
          validUntil: string;
        }
      >,
    ): Promise<{ readonly validUntil: string }>;
  };
  readonly references: {
    canonicalize(value: unknown): string;
    hashIntent(value: string): string;
    nextReference(kind: "Audit"): string;
  };
  readonly appendAudit: (
    tx: BrandStoreTopologyDraftTransaction,
    input: Readonly<
      BrandStoreTopologyActorScope & {
        auditReference: string;
        operationReference: string;
        intentDigest: string;
        purposeCode: "BRAND_STORE_TOPOLOGY_DRAFT";
        mode: "Save" | "Abandon";
        occurredAt: string;
      }
    >,
  ) => Promise<void>;
  /** Actual Tenant source supplies the complete Brand roster, including another
   * fresh observation in this owner's final guard. The callback must support that
   * held read without registering new children during the host's Checks phase. */
  readonly withCurrentStoreReferences: <T>(
    tx: BrandStoreTopologyDraftTransaction,
    input: Readonly<BrandStoreTopologyActorScope & { observedAt: string; validUntil: string }>,
    work: (roster: TenantStoreReferenceSnapshot) => Promise<T>,
  ) => Promise<T>;
}
const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const revisionColumns = `tenant_id,brand_id,draft_id,revision::text revision,operation_id,actor_id,audit_id,snapshot_digest,snapshot_json,${utc("created_at")} created_at,${utc("updated_at")} updated_at,created_at=date_trunc('milliseconds',created_at) AND updated_at=date_trunc('milliseconds',updated_at) precise`;
const operationColumns = `tenant_id,brand_id,operation_id,actor_id,expected_revision::text expected_revision,intent_digest,outcome,result_revision::text result_revision,result_draft_id,snapshot_digest,command_json,audit_id,${utc("occurred_at")} occurred_at,occurred_at=date_trunc('milliseconds',occurred_at) precise`;
/** Draft intent persistence only: no effective topology, approval or publication is inferred. */
export function createPostgresBrandStoreTopologyDraftStore(
  options: BrandStoreTopologyDraftStoreOptions,
) {
  const fixed = Object.freeze({
    tenantReference: parsePlatformTenantReference(options.tenantReference),
    brandReference: parseBrandReference(options.brandReference),
    actorReference: parseBrandReference(options.actorReference),
  });
  const tx = options.transaction,
    queryPort = tx.query,
    clock = options.clock,
    nowPort = clock.now,
    authority = options.authority,
    holdPort = authority.holdUntilTransactionCompletes,
    references = options.references,
    canonicalPort = references.canonicalize,
    hashPort = references.hashIntent,
    nextPort = references.nextReference,
    registerPort = options.registerBeforeCommit,
    auditPort = options.appendAudit,
    rosterPort = options.withCurrentStoreReferences;
  const origin = parseCanonicalInstant(options.originalObservedAt),
    originalUntil = parseCanonicalInstant(options.originalValidUntil);
  let latest = origin,
    deadline = originalUntil,
    failed = false,
    active = false,
    phase: "Work" | "Checks" | "Final" = "Work",
    registered = false,
    guardCalls = 0,
    finalCalls = 0,
    done = false,
    wrote = false;
  let original: Original | null = null,
    heldCurrent: BrandStoreTopologyDraftRevision | null | undefined,
    heldHistory: readonly BrandStoreTopologyDraftRevision[] | undefined,
    heldBrand: Record<string, unknown> | undefined,
    heldRoster: string | undefined;
  const modes = new Set<Mode>(),
    heldOperations = new Map<string, BrandStoreTopologyOperationReceipt>();
  const fail = (
    code: BrandStoreTopologyError["code"] = "BRAND_STORE_TOPOLOGY_DEPENDENCY_UNAVAILABLE",
  ): never => {
    failed = true;
    throw new BrandStoreTopologyError(code);
  };
  if (
    [
      queryPort,
      nowPort,
      holdPort,
      canonicalPort,
      hashPort,
      nextPort,
      registerPort,
      auditPort,
      rosterPort,
    ].some((p) => typeof p !== "function") ||
    originalUntil <= origin ||
    Date.parse(originalUntil) - Date.parse(origin) > 5000
  )
    return fail();
  function check() {
    if (
      failed ||
      options.transaction !== tx ||
      tx.query !== queryPort ||
      options.clock !== clock ||
      clock.now !== nowPort ||
      options.authority !== authority ||
      authority.holdUntilTransactionCompletes !== holdPort ||
      options.references !== references ||
      references.canonicalize !== canonicalPort ||
      references.hashIntent !== hashPort ||
      references.nextReference !== nextPort ||
      options.registerBeforeCommit !== registerPort ||
      options.appendAudit !== auditPort ||
      options.withCurrentStoreReferences !== rosterPort ||
      options.tenantReference !== fixed.tenantReference ||
      options.brandReference !== fixed.brandReference ||
      options.actorReference !== fixed.actorReference ||
      options.originalObservedAt !== origin ||
      options.originalValidUntil !== originalUntil
    )
      return fail();
    const at = parseCanonicalInstant(nowPort.call(clock));
    if (at < latest || at >= deadline) return fail();
    latest = at;
    return at;
  }
  function canonical(value: unknown) {
    check();
    const text = canonicalPort.call(references, value);
    check();
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 2101248) return fail();
    return text;
  }
  const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
  function hash(value: unknown) {
    const result = hashPort.call(references, canonical(value));
    check();
    if (typeof result !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(result)) return fail();
    return result;
  }
  const snapshotHash = (
    snapshot:
      Omit<BrandStoreTopologyDraftRevision, "snapshotDigest"> | BrandStoreTopologyDraftRevision,
  ) => {
    const { snapshotDigest: excluded, ...body } = snapshot as BrandStoreTopologyDraftRevision;
    void excluded;
    return hash(body);
  };
  function rows(value: unknown, max = 1): readonly Record<string, unknown>[] {
    const d =
      value && typeof value === "object"
        ? Object.getOwnPropertyDescriptor(value, "rows")
        : undefined;
    if (
      !d ||
      !("value" in d) ||
      !Array.isArray(d.value) ||
      Object.getPrototypeOf(d.value) !== Array.prototype ||
      d.value.length > max ||
      Reflect.ownKeys(d.value).length !== d.value.length + 1
    )
      return fail();
    return Array.from({ length: d.value.length }, (_, i) => {
      const entry = Object.getOwnPropertyDescriptor(d.value, String(i));
      if (
        !entry?.enumerable ||
        !("value" in entry) ||
        !entry.value ||
        typeof entry.value !== "object" ||
        Object.getPrototypeOf(entry.value) !== Object.prototype
      )
        return fail();
      const result: Record<string, unknown> = {};
      for (const key of Reflect.ownKeys(entry.value)) {
        const f = Object.getOwnPropertyDescriptor(entry.value, key);
        if (typeof key !== "string" || !f?.enumerable || !("value" in f)) return fail();
        result[key] = f.value;
      }
      return result;
    });
  }
  async function query(sql: string, values: readonly unknown[]) {
    const at = check();
    await queryPort.call(
      tx,
      "SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$1,true)",
      [String(Math.max(1, Date.parse(deadline) - Date.parse(at)))],
    );
    check();
    const result = await queryPort.call(tx, sql, values);
    check();
    return result;
  }
  async function insert(sql: string, values: readonly unknown[]) {
    const result = await query(sql, values),
      d =
        result && typeof result === "object"
          ? Object.getOwnPropertyDescriptor(result, "rowCount")
          : undefined;
    if (!d || !("value" in d) || d.value !== 1) return fail();
  }
  const restore = () =>
    query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
      [fixed.tenantReference, fixed.brandReference],
    );
  async function hold(mode: Mode) {
    const proof = await holdPort.call(
      authority,
      tx,
      Object.freeze({
        ...fixed,
        permission: "organization.manage" as const,
        purposeCode: "BRAND_STORE_TOPOLOGY_DRAFT" as const,
        mode,
        requiredFields: brandStoreTopologyDraftRequiredFields,
        command: original,
        observedAt: check(),
        validUntil: deadline,
      }),
    );
    check();
    const d =
      proof && typeof proof === "object"
        ? Object.getOwnPropertyDescriptor(proof, "validUntil")
        : undefined;
    if (
      !d?.enumerable ||
      !("value" in d) ||
      Object.getPrototypeOf(proof) !== Object.prototype ||
      Reflect.ownKeys(proof).length !== 1
    )
      return fail();
    const until = parseCanonicalInstant(d.value);
    if (until < deadline) deadline = until;
    check();
  }
  async function brandLock(write: boolean) {
    await restore();
    const result = rows(
      await query(
        `SELECT brand_id,lifecycle,version::text version,${utc("updated_at")} updated_at,updated_at=date_trunc('milliseconds',updated_at) precise FROM bop_tenant.brand WHERE brand_id=$1 FOR ${write ? "UPDATE" : "SHARE"}`,
        [fixed.brandReference],
      ),
    );
    const row = result[0];
    if (
      !row ||
      Object.keys(row).length !== 5 ||
      row.brand_id !== fixed.brandReference ||
      row.precise !== true ||
      typeof row.version !== "string" ||
      !/^[1-9][0-9]{0,18}$/u.test(row.version) ||
      BigInt(row.version) > 9223372036854775807n ||
      !organizationLifecycles.includes(row.lifecycle as (typeof organizationLifecycles)[number]) ||
      parseCanonicalInstant(row.updated_at) > check()
    )
      return fail();
    if (heldBrand && !same(heldBrand, row)) return fail("BRAND_STORE_TOPOLOGY_VERSION_CONFLICT");
    heldBrand ??= Object.freeze(row);
    return row.lifecycle;
  }
  function decodeRevision(row: Record<string, unknown>) {
    try {
      const snapshot = parseBrandStoreTopologyDraftRevision(row.snapshot_json);
      if (
        Object.keys(row).length !== 12 ||
        row.precise !== true ||
        row.tenant_id !== fixed.tenantReference ||
        row.brand_id !== fixed.brandReference ||
        snapshot.tenantReference !== fixed.tenantReference ||
        snapshot.brandReference !== fixed.brandReference ||
        row.draft_id !== snapshot.content.draftReference ||
        row.revision !== String(snapshot.revision) ||
        row.operation_id !== snapshot.operationReference ||
        row.actor_id !== snapshot.actorReference ||
        row.audit_id !== snapshot.auditReference ||
        row.created_at !== snapshot.createdAt ||
        row.updated_at !== snapshot.updatedAt ||
        snapshot.updatedAt > check() ||
        row.snapshot_digest !== snapshot.snapshotDigest ||
        snapshotHash(snapshot) !== snapshot.snapshotDigest ||
        !same(row.snapshot_json, snapshot)
      )
        return fail();
      return snapshot;
    } catch {
      return fail();
    }
  }
  async function readLatest() {
    await restore();
    const data = rows(
      await query(
        `SELECT ${revisionColumns} FROM bop_tenant.brand_store_topology_draft_revision WHERE tenant_id=$1 AND brand_id=$2 ORDER BY revision DESC LIMIT 1`,
        [fixed.tenantReference, fixed.brandReference],
      ),
    );
    return data[0] ? decodeRevision(data[0]) : null;
  }
  async function history() {
    await restore();
    const budget = rows(
      await query(
        "SELECT count(*)::text count,coalesce(sum(octet_length(snapshot_json::text)),0)::text bytes FROM bop_tenant.brand_store_topology_draft_revision WHERE tenant_id=$1 AND brand_id=$2",
        [fixed.tenantReference, fixed.brandReference],
      ),
    )[0];
    if (
      !budget ||
      typeof budget.count !== "string" ||
      !/^(0|[1-9][0-9]*)$/u.test(budget.count) ||
      typeof budget.bytes !== "string" ||
      !/^(0|[1-9][0-9]*)$/u.test(budget.bytes) ||
      BigInt(budget.count) > 1000n ||
      BigInt(budget.bytes) > 33554432n
    )
      return fail();
    const data = rows(
      await query(
        `SELECT ${revisionColumns} FROM bop_tenant.brand_store_topology_draft_revision WHERE tenant_id=$1 AND brand_id=$2 ORDER BY revision ASC LIMIT 1001`,
        [fixed.tenantReference, fixed.brandReference],
      ),
      1000,
    );
    if (String(data.length) !== budget.count) return fail();
    const revisions = data.map(decodeRevision);
    for (let i = 0; i < revisions.length; i++) {
      const revision = revisions[i];
      if (
        !revision ||
        revision.revision !== i + 1 ||
        (i > 0 &&
          (revision.content.draftReference !== revisions[0]?.content.draftReference ||
            revision.createdAt !== revisions[0]?.createdAt ||
            revision.updatedAt < (revisions[i - 1]?.updatedAt ?? revision.updatedAt)))
      )
        return fail();
    }
    return Object.freeze(revisions);
  }
  async function readOperation(operationReference: string) {
    await restore();
    const data = rows(
      await query(
        `SELECT ${operationColumns} FROM bop_tenant.brand_store_topology_draft_operation WHERE tenant_id=$1 AND brand_id=$2 AND operation_id=$3`,
        [fixed.tenantReference, fixed.brandReference, operationReference],
      ),
    );
    if (!data[0]) return null;
    const row = data[0];
    try {
      if (
        Object.keys(row).length !== 14 ||
        row.precise !== true ||
        row.tenant_id !== fixed.tenantReference ||
        row.brand_id !== fixed.brandReference ||
        row.operation_id !== operationReference ||
        row.actor_id !== fixed.actorReference
      )
        return fail("BRAND_STORE_TOPOLOGY_PERMISSION_DENIED");
      const expectedRevision = Number(row.expected_revision);
      if (String(expectedRevision) !== row.expected_revision) return fail();
      let snapshot: BrandStoreTopologyDraftRevision | null = null;
      if (row.outcome === "Committed") {
        const command = parseBrandStoreTopologySave(row.command_json);
        if (
          command.operationReference !== operationReference ||
          command.expectedRevision !== expectedRevision ||
          command.actorReference !== fixed.actorReference ||
          command.tenantReference !== fixed.tenantReference ||
          command.brandReference !== fixed.brandReference ||
          hash(command) !== row.intent_digest ||
          !same(command, row.command_json)
        )
          return fail();
        const found = rows(
          await query(
            `SELECT ${revisionColumns} FROM bop_tenant.brand_store_topology_draft_revision WHERE tenant_id=$1 AND brand_id=$2 AND revision=$3 AND operation_id=$4`,
            [fixed.tenantReference, fixed.brandReference, row.result_revision, operationReference],
          ),
        );
        if (!found[0]) return fail();
        snapshot = decodeRevision(found[0]);
        if (
          row.result_draft_id !== snapshot.content.draftReference ||
          row.result_revision !== String(snapshot.revision) ||
          row.snapshot_digest !== snapshot.snapshotDigest ||
          !same(command.content, snapshot.content)
        )
          return fail();
      } else if (
        row.outcome !== "Abandoned" ||
        row.result_revision !== null ||
        row.result_draft_id !== null ||
        row.snapshot_digest !== null ||
        row.command_json !== null
      )
        return fail();
      const receipt = parseBrandStoreTopologyOperationReceipt({
        profile: "BrandStoreTopologyOperationV1",
        ...fixed,
        operationReference,
        expectedRevision,
        intentDigest: row.intent_digest,
        outcome: row.outcome,
        snapshot,
        auditReference: row.audit_id,
        occurredAt: row.occurred_at,
        dataClassification: "ConfigurationMetadata",
      });
      if (receipt.occurredAt > check()) return fail();
      return receipt;
    } catch (error) {
      if (
        error instanceof BrandStoreTopologyError &&
        error.code === "BRAND_STORE_TOPOLOGY_PERMISSION_DENIED"
      )
        throw error;
      return fail();
    }
  }
  async function lookup(command: Original) {
    const receipt = await readOperation(command.operationReference);
    if (!receipt) return null;
    const intent =
      command.profile === "BrandStoreTopologySaveV1" ? hash(command) : command.intentDigest;
    if (receipt.expectedRevision !== command.expectedRevision || receipt.intentDigest !== intent)
      return fail("BRAND_STORE_TOPOLOGY_OPERATION_INTENT_CONFLICT");
    return receipt;
  }
  function rosterIdentity(roster: TenantStoreReferenceSnapshot) {
    const { observedAt, originalIntentDigest, ...facts } = roster;
    void observedAt;
    void originalIntentDigest;
    return canonical(facts);
  }
  async function withRoster<T>(
    work: (roster: TenantStoreReferenceSnapshot) => Promise<T>,
  ): Promise<T> {
    const observedAt = check();
    let calls = 0;
    const completed: { value?: { result: T } } = {};
    let callbackFailure: BrandStoreTopologyError | undefined;
    let answer: unknown;
    try {
      answer = await rosterPort.call(
        options,
        tx,
        Object.freeze({ ...fixed, observedAt, validUntil: deadline }),
        async (raw) => {
          try {
            if (++calls !== 1) return fail();
            check();
            const roster = parseTenantStoreReferenceSnapshot(raw);
            if (
              roster.brandReference !== fixed.brandReference ||
              roster.observedAt < observedAt ||
              roster.observedAt > check()
            )
              return fail();
            const signature = rosterIdentity(roster);
            if (heldRoster !== undefined && signature !== heldRoster)
              return fail("BRAND_STORE_TOPOLOGY_VERSION_CONFLICT");
            heldRoster ??= signature;
            const result = { result: await work(roster) };
            completed.value = result;
            check();
            return result;
          } catch (error) {
            failed = true;
            if (error instanceof BrandStoreTopologyError) callbackFailure ??= error;
            throw error;
          }
        },
      );
    } catch (error) {
      if (callbackFailure) throw callbackFailure;
      throw error;
    }
    if (calls !== 1 || !completed.value || answer !== completed.value) return fail();
    check();
    return completed.value.result;
  }
  async function admit(mode: Mode, command: Original | null) {
    if (active || phase !== "Work") return fail();
    active = true;
    if (command) {
      if (
        command.tenantReference !== fixed.tenantReference ||
        command.brandReference !== fixed.brandReference ||
        command.actorReference !== fixed.actorReference
      )
        return fail("BRAND_STORE_TOPOLOGY_PERMISSION_DENIED");
      if (original && !same(original, command)) return fail();
      original = command;
    }
    modes.add(mode);
    if (!registered) {
      registered = true;
      const returned = await registerPort.call(
        options,
        tx,
        async () => {
          try {
            if (++guardCalls !== 1 || active || phase !== "Work") return fail();
            phase = "Checks";
            for (const mode of modes) await hold(mode);
            await brandLock([...modes].some((mode) => mode !== "Read"));
            if (heldRoster !== undefined) await withRoster(async () => undefined);
            if (heldCurrent !== undefined && !same(await readLatest(), heldCurrent))
              return fail("BRAND_STORE_TOPOLOGY_VERSION_CONFLICT");
            if (heldHistory !== undefined && !same(await history(), heldHistory))
              return fail("BRAND_STORE_TOPOLOGY_VERSION_CONFLICT");
            for (const [op, receipt] of heldOperations)
              if (!same(await readOperation(op), receipt)) return fail();
            await restore();
            if (wrote)
              await query(
                "SET CONSTRAINTS bop_tenant.brand_store_topology_revision_coherence,bop_tenant.brand_store_topology_operation_coherence IMMEDIATE",
                [],
              );
            check();
            done = true;
          } catch (error) {
            failed = true;
            throw error;
          }
        },
        () => {
          if (++finalCalls !== 1 || !done || guardCalls !== 1 || active || phase !== "Checks")
            return fail();
          check();
          phase = "Final";
        },
      );
      if (returned !== undefined) return fail();
    }
    await hold(mode);
    await restore();
    const isolation = rows(
      await query("SELECT current_setting('transaction_isolation') isolation", []),
    );
    if (isolation.length !== 1 || isolation[0]?.isolation !== "read committed") return fail();
    if (command)
      await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `BrandStoreTopologyOriginal:${command.operationReference}`,
      ]);
    return brandLock(mode !== "Read");
  }
  async function protect<T>(work: () => Promise<T>) {
    try {
      check();
      const result = await work();
      check();
      return result;
    } catch (error) {
      failed = true;
      if (error instanceof BrandStoreTopologyError) throw error;
      return fail();
    } finally {
      active = false;
    }
  }
  async function append(
    command: Original,
    snapshot: BrandStoreTopologyDraftRevision | null,
    at: string,
    auditReference: string,
  ) {
    const intentDigest =
      command.profile === "BrandStoreTopologySaveV1" ? hash(command) : command.intentDigest;
    await auditPort.call(
      options,
      tx,
      Object.freeze({
        ...fixed,
        auditReference,
        operationReference: command.operationReference,
        intentDigest,
        purposeCode: "BRAND_STORE_TOPOLOGY_DRAFT" as const,
        mode: snapshot ? ("Save" as const) : ("Abandon" as const),
        occurredAt: at,
      }),
    );
    check();
    await restore();
    await insert(
      "INSERT INTO bop_tenant.brand_store_topology_draft_operation(tenant_id,brand_id,operation_id,actor_id,expected_revision,intent_digest,outcome,result_revision,result_draft_id,snapshot_digest,command_json,audit_id,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)",
      [
        fixed.tenantReference,
        fixed.brandReference,
        command.operationReference,
        fixed.actorReference,
        command.expectedRevision,
        intentDigest,
        snapshot ? "Committed" : "Abandoned",
        snapshot?.revision ?? null,
        snapshot?.content.draftReference ?? null,
        snapshot?.snapshotDigest ?? null,
        snapshot && command.profile === "BrandStoreTopologySaveV1" ? canonical(command) : null,
        auditReference,
        at,
      ],
    );
    wrote = true;
    const receipt = await lookup(command);
    if (!receipt) return fail();
    heldOperations.set(command.operationReference, receipt);
    return receipt;
  }
  return Object.freeze({
    readCurrent: () =>
      protect(async () => {
        await admit("Read", null);
        heldCurrent = await readLatest();
        await hold("Read");
        const observedAt = check();
        return parseBrandStoreTopologyCurrent(
          {
            profile: "BrandStoreTopologyCurrentV1",
            ...fixed,
            current: heldCurrent,
            observedAt,
            validUntil: deadline,
          },
          check(),
        );
      }),
    readHistory: () =>
      protect(async () => {
        await admit("Read", null);
        heldHistory = await history();
        await hold("Read");
        return heldHistory;
      }),
    save: (value: unknown) =>
      protect(async () => {
        const command = parseBrandStoreTopologySave(value),
          lifecycle = await admit("Save", command),
          recorded = await lookup(command);
        if (recorded) {
          heldOperations.set(command.operationReference, recorded);
          await hold("Save");
          return recorded;
        }
        if (lifecycle === "Archived") return fail("BRAND_STORE_TOPOLOGY_PERMISSION_DENIED");
        const current = await readLatest();
        if (
          (current?.revision ?? 0) !== command.expectedRevision ||
          (current && current.content.draftReference !== command.content.draftReference)
        )
          return fail("BRAND_STORE_TOPOLOGY_VERSION_CONFLICT");
        const receipt = await withRoster(async (roster) => {
          try {
            const content = validateBrandStoreTopologyDraftStores(command.content, roster),
              at = check(),
              auditReference = parseBrandReference(nextPort.call(references, "Audit"));
            check();
            const body = {
              profile: "BrandStoreTopologyDraftRevisionV1" as const,
              ...fixed,
              revision: command.expectedRevision + 1,
              content,
              operationReference: command.operationReference,
              auditReference,
              createdAt: current?.createdAt ?? at,
              updatedAt: at,
              dataClassification: "ConfigurationMetadata" as const,
            };
            const snapshot = parseBrandStoreTopologyDraftRevision({
              ...body,
              snapshotDigest: snapshotHash(body),
            });
            await hold("Save");
            await restore();
            await insert(
              "INSERT INTO bop_tenant.brand_store_topology_draft_revision(tenant_id,brand_id,draft_id,revision,operation_id,actor_id,audit_id,snapshot_digest,snapshot_json,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)",
              [
                fixed.tenantReference,
                fixed.brandReference,
                snapshot.content.draftReference,
                snapshot.revision,
                snapshot.operationReference,
                snapshot.actorReference,
                snapshot.auditReference,
                snapshot.snapshotDigest,
                canonical(snapshot),
                snapshot.createdAt,
                snapshot.updatedAt,
              ],
            );
            const receipt = await append(command, snapshot, at, auditReference);
            heldCurrent = snapshot;
            if (heldHistory) heldHistory = Object.freeze([...heldHistory, snapshot]);
            return receipt;
          } catch (error) {
            failed = true;
            throw error;
          }
        });
        await hold("Save");
        return receipt;
      }),
    resolve: (value: unknown) =>
      protect(async () => {
        const command = parseBrandStoreTopologyResolve(value);
        await admit("Resolve", command);
        const recorded = await lookup(command);
        if (recorded) {
          heldOperations.set(command.operationReference, recorded);
          await hold("Resolve");
          return recorded;
        }
        const at = check(),
          auditReference = parseBrandReference(nextPort.call(references, "Audit"));
        check();
        const receipt = await append(command, null, at, auditReference);
        await hold("Resolve");
        return receipt;
      }),
    assertFinalized(actual: BrandStoreTopologyDraftTransaction): string {
      if (
        actual !== tx ||
        phase !== "Final" ||
        active ||
        !done ||
        guardCalls !== 1 ||
        finalCalls !== 1
      )
        return fail();
      check();
      return deadline;
    },
  });
}
