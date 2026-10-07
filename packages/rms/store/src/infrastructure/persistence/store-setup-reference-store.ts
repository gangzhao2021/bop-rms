import { parseCanonicalInstant } from "@bop/tenant";
import { parseStoreAdministrationReference } from "../../contracts/store-configuration-administration.js";
import {
  parseStoreSetupReferenceVersion,
  parseStoreSetupReferenceSave,
  parseStoreSetupReferenceResolve,
  parseStoreSetupReferenceReceipt,
  parseStoreSetupReferencesCurrent,
  parseStoreSetupReferenceIntentDigest,
  StoreSetupReferenceError,
  type StoreSetupReferenceActorScope,
  storeSetupReferenceOperationRequiredFields,
  type StoreSetupReferenceKind,
  type StoreSetupReferenceVersion,
  type StoreSetupReferenceSave,
  type StoreSetupReferenceResolve,
  type StoreSetupReferenceReceipt,
} from "../../contracts/store-setup-reference.js";
export interface StoreSetupReferenceTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
type Original = StoreSetupReferenceSave | StoreSetupReferenceResolve;
type Mode = "ReadAll" | "ReadVersion" | "Save" | "Resolve";
export interface StoreSetupReferenceStoreOptions extends StoreSetupReferenceActorScope {
  readonly transaction: StoreSetupReferenceTransaction;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly registerBeforeCommit: (
    tx: StoreSetupReferenceTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void> | void;
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: StoreSetupReferenceTransaction,
      input: Readonly<
        StoreSetupReferenceActorScope & {
          permission: "organization.manage";
          purposeCode: "STORE_SETUP_REFERENCE";
          mode: Mode;
          kind: StoreSetupReferenceKind | null;
          requiredFields: typeof storeSetupReferenceOperationRequiredFields;
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
    nextReference(kind: "Reference" | "Audit"): string;
  };
  readonly appendAudit: (
    tx: StoreSetupReferenceTransaction,
    input: Readonly<
      StoreSetupReferenceActorScope & {
        kind: StoreSetupReferenceKind;
        operationReference: string;
        auditReference: string;
        intentDigest: string;
        purposeCode: "STORE_SETUP_REFERENCE";
        mode: "Save" | "Abandon";
        occurredAt: string;
      }
    >,
  ) => Promise<void>;
}
const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const versionColumns = `reference_kind,reference_id,revision::text revision,operation_id,actor_id,previous_reference_id,snapshot_json,snapshot_digest,${utc("created_at")} created_at,${utc("updated_at")} updated_at`;
/** Private owning address/contact history. It does not prove external address,
 * phone verification, complete configuration eligibility or a public profile. */
export function createPostgresStoreSetupReferenceStore(options: StoreSetupReferenceStoreOptions) {
  const tx = options.transaction,
    queryPort = tx.query,
    clockOwner = options.clock,
    clockPort = clockOwner.now,
    authorityOwner = options.authority,
    holdPort = authorityOwner.holdUntilTransactionCompletes,
    referenceOwner = options.references,
    canonicalPort = referenceOwner.canonicalize,
    hashPort = referenceOwner.hashIntent,
    nextPort = referenceOwner.nextReference,
    registerPort = options.registerBeforeCommit,
    auditPort = options.appendAudit;
  const fixed = {
    tenantReference: parseStoreAdministrationReference(options.tenantReference),
    brandReference: parseStoreAdministrationReference(options.brandReference),
    storeReference: parseStoreAdministrationReference(options.storeReference),
    actorReference: parseStoreAdministrationReference(options.actorReference),
  };
  const origin = parseCanonicalInstant(options.originalObservedAt),
    originalUntil = parseCanonicalInstant(options.originalValidUntil);
  let latest = origin,
    deadline = originalUntil,
    failed = false,
    active = false,
    registered = false,
    phase: "Work" | "Checks" | "Final" = "Work",
    guardCalls = 0,
    guardComplete = false,
    finalCalls = 0,
    wroteTerminal = false;
  let command: Original | null = null,
    mode: Mode | null = null;
  let heldCurrent:
    | Readonly<{
        address: StoreSetupReferenceVersion | null;
        contact: StoreSetupReferenceVersion | null;
      }>
    | undefined;
  let historicalSelector:
    Readonly<{ kind: StoreSetupReferenceKind; reference: string }> | undefined;
  let heldHistorical:
    | Readonly<{
        snapshot: StoreSetupReferenceVersion | null;
        receipt: StoreSetupReferenceReceipt | null;
      }>
    | undefined;
  let heldWritten: StoreSetupReferenceVersion | undefined,
    originalReceipt: StoreSetupReferenceReceipt | undefined;
  const fail = (
    code: StoreSetupReferenceError["code"] = "STORE_SETUP_REFERENCE_DEPENDENCY_UNAVAILABLE",
  ): never => {
    failed = true;
    throw new StoreSetupReferenceError(code);
  };
  const stored = <T>(read: () => T): T => {
    try {
      return read();
    } catch {
      return fail();
    }
  };
  if (
    [
      queryPort,
      clockPort,
      holdPort,
      canonicalPort,
      hashPort,
      nextPort,
      registerPort,
      auditPort,
    ].some((port) => typeof port !== "function") ||
    originalUntil <= origin ||
    Date.parse(originalUntil) - Date.parse(origin) > 5000
  )
    return fail();
  const check = () => {
    if (
      failed ||
      options.transaction !== tx ||
      tx.query !== queryPort ||
      options.clock !== clockOwner ||
      clockOwner.now !== clockPort ||
      options.authority !== authorityOwner ||
      authorityOwner.holdUntilTransactionCompletes !== holdPort ||
      options.references !== referenceOwner ||
      referenceOwner.canonicalize !== canonicalPort ||
      referenceOwner.hashIntent !== hashPort ||
      referenceOwner.nextReference !== nextPort ||
      options.registerBeforeCommit !== registerPort ||
      options.appendAudit !== auditPort ||
      (mode === "ReadVersion" &&
        (Object.entries(fixed).some(
          ([key, value]) => Object.getOwnPropertyDescriptor(options, key)?.value !== value,
        ) ||
          Object.getOwnPropertyDescriptor(options, "originalObservedAt")?.value !== origin ||
          Object.getOwnPropertyDescriptor(options, "originalValidUntil")?.value !== originalUntil))
    )
      return fail();
    const at = parseCanonicalInstant(clockPort.call(clockOwner));
    if (at < latest || at >= deadline) return fail();
    latest = at;
    return at;
  };
  const canonical = (value: unknown) => {
    check();
    const text = canonicalPort.call(referenceOwner, value);
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 65536) return fail();
    check();
    return text;
  };
  const digest = (value: unknown) => {
    const result = parseStoreSetupReferenceIntentDigest(
      hashPort.call(referenceOwner, canonical(value)),
    );
    check();
    return result;
  };
  const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
  const rows = (value: unknown, maximum = 1): readonly Record<string, unknown>[] => {
    if (!value || typeof value !== "object") return fail();
    const d = Object.getOwnPropertyDescriptor(value, "rows");
    if (
      !d ||
      !("value" in d) ||
      !Array.isArray(d.value) ||
      Object.getPrototypeOf(d.value) !== Array.prototype ||
      d.value.length > maximum ||
      Reflect.ownKeys(d.value).length !== d.value.length + 1
    )
      return fail();
    return Array.from({ length: d.value.length }, (_, i) => {
      const row = Object.getOwnPropertyDescriptor(d.value, String(i));
      if (
        !row?.enumerable ||
        !("value" in row) ||
        !row.value ||
        typeof row.value !== "object" ||
        Array.isArray(row.value) ||
        Object.getPrototypeOf(row.value) !== Object.prototype ||
        Reflect.ownKeys(row.value).some((key) => {
          const field = Object.getOwnPropertyDescriptor(row.value, key);
          return typeof key !== "string" || !field?.enumerable || !("value" in field);
        })
      )
        return fail();
      return row.value as Record<string, unknown>;
    });
  };
  const query = async (sql: string, values: readonly unknown[]) => {
    check();
    await queryPort.call(
      tx,
      "SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$1,true)",
      [String(Math.max(1, Date.parse(deadline) - Date.parse(latest)))],
    );
    check();
    const result = await queryPort.call(tx, sql, values);
    check();
    return result;
  };
  const insert = async (sql: string, values: readonly unknown[]) => {
    const result = await query(sql, values);
    const count =
      result && typeof result === "object"
        ? Object.getOwnPropertyDescriptor(result, "rowCount")
        : undefined;
    if (!count || !("value" in count) || count.value !== 1) return fail();
  };
  const restore = () =>
    query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
      [fixed.tenantReference, fixed.brandReference, fixed.storeReference],
    );
  const hold = async () => {
    if (mode === null) return fail();
    const proof = await holdPort.call(
      authorityOwner,
      tx,
      Object.freeze({
        ...fixed,
        permission: "organization.manage",
        purposeCode: "STORE_SETUP_REFERENCE",
        mode,
        kind: command?.kind ?? historicalSelector?.kind ?? null,
        requiredFields: storeSetupReferenceOperationRequiredFields,
        command,
        observedAt: check(),
        validUntil: deadline,
      }),
    );
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
  };
  const root = async (kind: StoreSetupReferenceKind) => {
    await restore();
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `StoreSetupReferenceRoot:${fixed.tenantReference}:${fixed.brandReference}:${fixed.storeReference}:${kind}`,
    ]);
  };
  const roots = async () => {
    if (command) await root(command.kind);
    else if (historicalSelector) await root(historicalSelector.kind);
    else {
      await root("Address");
      await root("Contact");
    }
  };
  const decodeVersion = (
    row: Record<string, unknown>,
    kind: StoreSetupReferenceKind,
  ): StoreSetupReferenceVersion => {
    if (Reflect.ownKeys(row).length !== 10) return fail();
    const snapshot = stored(() => parseStoreSetupReferenceVersion(row.snapshot_json));
    if (
      snapshot.tenantReference !== fixed.tenantReference ||
      snapshot.brandReference !== fixed.brandReference ||
      snapshot.storeReference !== fixed.storeReference ||
      snapshot.kind !== kind ||
      row.reference_kind !== kind ||
      row.reference_id !== snapshot.reference ||
      row.revision !== String(snapshot.revision) ||
      row.actor_id !== snapshot.authoredByReference ||
      row.previous_reference_id !== snapshot.previousReference ||
      row.created_at !== snapshot.createdAt ||
      row.updated_at !== snapshot.updatedAt ||
      snapshot.updatedAt > check() ||
      digest(snapshot) !== row.snapshot_digest
    )
      return fail();
    parseStoreAdministrationReference(row.operation_id);
    return snapshot;
  };
  const readLatest = async (kind: StoreSetupReferenceKind) => {
    await restore();
    const found = rows(
      await query(
        `SELECT ${versionColumns} FROM rms_store.store_setup_reference_version WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND reference_kind=$4 ORDER BY revision DESC LIMIT 1`,
        [fixed.tenantReference, fixed.brandReference, fixed.storeReference, kind],
      ),
    );
    return found[0] ? decodeVersion(found[0], kind) : null;
  };
  const lookup = async (
    original: Original,
    sourceActor = fixed.actorReference,
  ): Promise<StoreSetupReferenceReceipt | null> => {
    await restore();
    const found = rows(
      await query(
        `SELECT operation_id,tenant_id,brand_id,store_id,reference_kind,actor_id,intent_digest,expected_reference_id,expected_revision::text expected_revision,outcome,result_reference_id,result_revision::text result_revision,snapshot_digest,audit_reference,${utc("occurred_at")} occurred_at FROM rms_store.store_setup_reference_operation WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4`,
        [
          fixed.tenantReference,
          fixed.brandReference,
          fixed.storeReference,
          original.operationReference,
        ],
      ),
    );
    if (!found[0]) return null;
    const row = found[0];
    if (Reflect.ownKeys(row).length !== 15) return fail();
    if (row.operation_id !== original.operationReference) return fail();
    if (
      row.tenant_id !== fixed.tenantReference ||
      row.brand_id !== fixed.brandReference ||
      row.store_id !== fixed.storeReference ||
      row.actor_id !== sourceActor
    )
      return fail("STORE_SETUP_REFERENCE_PERMISSION_DENIED");
    if (row.reference_kind !== original.kind)
      return fail("STORE_SETUP_REFERENCE_IDEMPOTENCY_CONFLICT");
    const expectedRevision = Number(row.expected_revision);
    if (
      !Number.isSafeInteger(expectedRevision) ||
      String(expectedRevision) !== row.expected_revision
    )
      return fail();
    let snapshot: StoreSetupReferenceVersion | null = null;
    if (row.outcome === "Committed") {
      const versions = rows(
        await query(
          `SELECT ${versionColumns} FROM rms_store.store_setup_reference_version WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND reference_kind=$4 AND reference_id=$5 AND revision=$6 AND operation_id=$7`,
          [
            fixed.tenantReference,
            fixed.brandReference,
            fixed.storeReference,
            original.kind,
            row.result_reference_id,
            row.result_revision,
            row.operation_id,
          ],
        ),
      );
      if (!versions[0] || versions[0].operation_id !== row.operation_id) return fail();
      snapshot = decodeVersion(versions[0], original.kind);
      if (
        snapshot.reference !== row.result_reference_id ||
        digest(snapshot) !== row.snapshot_digest ||
        String(snapshot.revision) !== row.result_revision
      )
        return fail();
    } else if (
      row.outcome !== "Abandoned" ||
      row.result_reference_id !== null ||
      row.result_revision !== null ||
      row.snapshot_digest !== null
    )
      return fail();
    const receipt = stored(() =>
      parseStoreSetupReferenceReceipt({
        profile: "StoreSetupReferenceReceiptV1",
        ...fixed,
        actorReference: sourceActor,
        kind: original.kind,
        operationReference: row.operation_id,
        expectedReference: row.expected_reference_id,
        expectedRevision,
        intentDigest: row.intent_digest,
        outcome: row.outcome,
        snapshot,
        auditReference: row.audit_reference,
        occurredAt: row.occurred_at,
      }),
    );
    if (receipt.occurredAt > check()) return fail();
    if (snapshot) {
      const persisted = snapshot;
      const originalSave = stored(() =>
        parseStoreSetupReferenceSave({
          profile: "StoreSetupReferenceSaveV1",
          ...fixed,
          actorReference: sourceActor,
          kind: persisted.kind,
          operationReference: receipt.operationReference,
          expectedReference: receipt.expectedReference,
          expectedRevision: receipt.expectedRevision,
          purposeCode: "STORE_SETUP_REFERENCE",
          content: persisted.content,
        }),
      );
      if (digest(originalSave) !== receipt.intentDigest) return fail();
    }
    const requested =
      original.profile === "StoreSetupReferenceSaveV1" ? digest(original) : original.intentDigest;
    if (
      receipt.intentDigest !== requested ||
      receipt.expectedReference !== original.expectedReference ||
      receipt.expectedRevision !== original.expectedRevision
    )
      return fail("STORE_SETUP_REFERENCE_IDEMPOTENCY_CONFLICT");
    return receipt;
  };
  const append = async (
    original: Original,
    snapshot: StoreSetupReferenceVersion | null,
    at: string,
  ) => {
    const intentDigest =
      original.profile === "StoreSetupReferenceSaveV1" ? digest(original) : original.intentDigest;
    const auditReference = parseStoreAdministrationReference(
      nextPort.call(referenceOwner, "Audit"),
    );
    check();
    const returned = await auditPort.call(
      options,
      tx,
      Object.freeze({
        ...fixed,
        kind: original.kind,
        operationReference: original.operationReference,
        auditReference,
        intentDigest,
        purposeCode: "STORE_SETUP_REFERENCE",
        mode: snapshot ? "Save" : "Abandon",
        occurredAt: at,
      }),
    );
    if (returned !== undefined) return fail();
    check();
    await restore();
    await insert(
      "INSERT INTO rms_store.store_setup_reference_operation(operation_id,tenant_id,brand_id,store_id,reference_kind,actor_id,intent_digest,expected_reference_id,expected_revision,outcome,result_reference_id,result_revision,snapshot_digest,audit_reference,occurred_at,data_classification) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'Internal')",
      [
        original.operationReference,
        fixed.tenantReference,
        fixed.brandReference,
        fixed.storeReference,
        original.kind,
        fixed.actorReference,
        intentDigest,
        original.expectedReference,
        original.expectedRevision,
        snapshot ? "Committed" : "Abandoned",
        snapshot?.reference ?? null,
        snapshot?.revision ?? null,
        snapshot ? digest(snapshot) : null,
        auditReference,
        at,
      ],
    );
    wroteTerminal = true;
    return parseStoreSetupReferenceReceipt({
      profile: "StoreSetupReferenceReceiptV1",
      ...fixed,
      kind: original.kind,
      operationReference: original.operationReference,
      expectedReference: original.expectedReference,
      expectedRevision: original.expectedRevision,
      intentDigest,
      outcome: snapshot ? "Committed" : "Abandoned",
      snapshot,
      auditReference,
      occurredAt: at,
    });
  };
  const readHistorical = async (
    selector: Readonly<{ kind: StoreSetupReferenceKind; reference: string }>,
  ) => {
    await restore();
    const found = rows(
      await query(
        `SELECT ${versionColumns} FROM rms_store.store_setup_reference_version WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND reference_kind=$4 AND reference_id=$5`,
        [
          fixed.tenantReference,
          fixed.brandReference,
          fixed.storeReference,
          selector.kind,
          selector.reference,
        ],
      ),
    );
    const row = found[0];
    if (!row) return Object.freeze({ snapshot: null, receipt: null });
    const snapshot = decodeVersion(row, selector.kind);
    if (snapshot.reference !== selector.reference) return fail();
    const original = stored(() =>
      parseStoreSetupReferenceSave({
        profile: "StoreSetupReferenceSaveV1",
        ...fixed,
        actorReference: snapshot.authoredByReference,
        kind: snapshot.kind,
        operationReference: row.operation_id,
        expectedReference: snapshot.previousReference,
        expectedRevision: snapshot.revision - 1,
        content: snapshot.content,
        purposeCode: "STORE_SETUP_REFERENCE",
      }),
    );
    const receipt = await lookup(
      original,
      parseStoreAdministrationReference(original.actorReference),
    );
    if (!receipt || receipt.outcome !== "Committed" || !same(receipt.snapshot, snapshot))
      return fail();
    return Object.freeze({ snapshot, receipt });
  };
  const admit = async (selected: Mode, original: Original | null) => {
    if (active || phase !== "Work" || (mode !== null && mode !== selected)) return fail();
    active = true;
    mode = selected;
    if (original) {
      if (
        Object.entries(fixed).some(
          ([key, value]) => Object.getOwnPropertyDescriptor(original, key)?.value !== value,
        )
      )
        return fail("STORE_SETUP_REFERENCE_PERMISSION_DENIED");
      if (command && !same(command, original))
        return fail("STORE_SETUP_REFERENCE_IDEMPOTENCY_CONFLICT");
      command = original;
    }
    if (!registered) {
      registered = true;
      const value = await registerPort.call(
        options,
        tx,
        async () => {
          try {
            if (++guardCalls !== 1 || active || phase !== "Work") return fail();
            phase = "Checks";
            await hold();
            await roots();
            if (heldCurrent) {
              const current = {
                address: await readLatest("Address"),
                contact: await readLatest("Contact"),
              };
              if (!same(current, heldCurrent))
                return fail("STORE_SETUP_REFERENCE_VERSION_CONFLICT");
            }
            if (historicalSelector && heldHistorical) {
              const current = await readHistorical(historicalSelector);
              if (!same(current, heldHistorical))
                return fail("STORE_SETUP_REFERENCE_VERSION_CONFLICT");
            }
            if (heldWritten) {
              const current = await readLatest(heldWritten.kind);
              if (!same(current, heldWritten))
                return fail("STORE_SETUP_REFERENCE_VERSION_CONFLICT");
            }
            if (originalReceipt && command) {
              const current = await lookup(command);
              if (!same(current, originalReceipt)) return fail();
            }
            await restore();
            if (wroteTerminal)
              await query(
                "SET CONSTRAINTS rms_store.store_setup_reference_version_coherence,rms_store.store_setup_reference_operation_coherence IMMEDIATE",
                [],
              );
            check();
            guardComplete = true;
          } catch (error) {
            failed = true;
            throw error;
          }
        },
        () => {
          if (
            ++finalCalls !== 1 ||
            !guardComplete ||
            guardCalls !== 1 ||
            active ||
            phase !== "Checks"
          )
            return fail();
          check();
          phase = "Final";
        },
      );
      if (value !== undefined) return fail();
    }
    await hold();
    await restore();
    const isolation = rows(
      await query("SELECT current_setting('transaction_isolation') isolation", []),
    );
    if (isolation.length !== 1 || isolation[0]?.isolation !== "read committed") return fail();
    if (original)
      await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "StoreSetupReferenceOperation:" + original.operationReference,
      ]);
    await roots();
  };
  const protect = async <T>(work: () => Promise<T>) => {
    try {
      check();
      const result = await work();
      check();
      active = false;
      return result;
    } catch (error) {
      failed = true;
      if (error instanceof StoreSetupReferenceError) throw error;
      return fail();
    }
  };
  return Object.freeze({
    readCurrent: () =>
      protect(async () => {
        await admit("ReadAll", null);
        const current = Object.freeze({
          address: await readLatest("Address"),
          contact: await readLatest("Contact"),
        });
        heldCurrent = current;
        await hold();
        return parseStoreSetupReferencesCurrent({
          profile: "StoreSetupReferencesCurrentV1",
          ...fixed,
          ...current,
          observedAt: check(),
          validUntil: deadline,
          businessReferenceValidation: "NotEvaluated",
        });
      }),
    readVersion: (value: unknown) =>
      protect(async () => {
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          Object.getPrototypeOf(value) !== Object.prototype ||
          Reflect.ownKeys(value).length !== 2
        )
          return fail("STORE_SETUP_REFERENCE_INPUT_INVALID");
        const kind = Object.getOwnPropertyDescriptor(value, "kind"),
          reference = Object.getOwnPropertyDescriptor(value, "reference");
        if (
          !kind?.enumerable ||
          !("value" in kind) ||
          !reference?.enumerable ||
          !("value" in reference) ||
          (kind.value !== "Address" && kind.value !== "Contact")
        )
          return fail("STORE_SETUP_REFERENCE_INPUT_INVALID");
        let parsedReference: string;
        try {
          parsedReference = parseStoreAdministrationReference(reference.value);
        } catch {
          return fail("STORE_SETUP_REFERENCE_INPUT_INVALID");
        }
        const selector = Object.freeze({ kind: kind.value, reference: parsedReference });
        if (historicalSelector && !same(historicalSelector, selector)) return fail();
        historicalSelector = selector;
        await admit("ReadVersion", null);
        const actual = await readHistorical(selector);
        if (heldHistorical && !same(heldHistorical, actual))
          return fail("STORE_SETUP_REFERENCE_VERSION_CONFLICT");
        heldHistorical = actual;
        await hold();
        return actual.snapshot;
      }),
    save: (value: unknown) =>
      protect(async () => {
        const original = parseStoreSetupReferenceSave(value);
        await admit("Save", original);
        const old = await lookup(original);
        if (old) {
          originalReceipt = old;
          await hold();
          return old;
        }
        const prior = await readLatest(original.kind);
        if (
          (prior?.revision ?? 0) !== original.expectedRevision ||
          (prior?.reference ?? null) !== original.expectedReference
        )
          return fail("STORE_SETUP_REFERENCE_VERSION_CONFLICT");
        const reference = parseStoreAdministrationReference(
          nextPort.call(referenceOwner, "Reference"),
        );
        check();
        if (reference === prior?.reference) return fail();
        const at = check();
        const snapshot = parseStoreSetupReferenceVersion({
          profile: "StoreSetupReferenceVersionV1",
          tenantReference: fixed.tenantReference,
          brandReference: fixed.brandReference,
          storeReference: fixed.storeReference,
          kind: original.kind,
          reference,
          revision: original.expectedRevision + 1,
          authoredByReference: fixed.actorReference,
          previousReference: prior?.reference ?? null,
          content: original.content,
          createdAt: prior?.createdAt ?? at,
          updatedAt: at,
          dataClassification: "Internal",
        });
        await hold();
        await restore();
        await insert(
          "INSERT INTO rms_store.store_setup_reference_version(tenant_id,brand_id,store_id,reference_kind,reference_id,revision,operation_id,actor_id,previous_reference_id,snapshot_json,snapshot_digest,created_at,updated_at,data_classification) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,'Internal')",
          [
            fixed.tenantReference,
            fixed.brandReference,
            fixed.storeReference,
            original.kind,
            reference,
            snapshot.revision,
            original.operationReference,
            fixed.actorReference,
            snapshot.previousReference,
            canonical(snapshot),
            digest(snapshot),
            snapshot.createdAt,
            snapshot.updatedAt,
          ],
        );
        const receipt = await append(original, snapshot, at);
        heldWritten = snapshot;
        originalReceipt = receipt;
        await hold();
        return receipt;
      }),
    resolve: (value: unknown) =>
      protect(async () => {
        const original = parseStoreSetupReferenceResolve(value);
        await admit("Resolve", original);
        const old = await lookup(original);
        if (old) {
          originalReceipt = old;
          await hold();
          return old;
        }
        const receipt = await append(original, null, check());
        originalReceipt = receipt;
        await hold();
        return receipt;
      }),
    assertFinalized(actual: StoreSetupReferenceTransaction): string {
      if (
        actual !== tx ||
        phase !== "Final" ||
        guardCalls !== 1 ||
        !guardComplete ||
        finalCalls !== 1 ||
        active
      )
        return fail();
      check();
      return deadline;
    },
  });
}
