import {
  createStoreSetupFeeContextPreparation,
  createStoreSetupFeeContextPreparationFromRecordedRevision,
} from "../../contracts/store-setup-fee-context-preparation.js";
import { parseCanonicalInstant } from "@bop/tenant";
import {
  createStoreSetupDraft,
  replaceStoreSetupDraftContent,
  parseStoreSetupDraft,
  StoreSetupDraftError,
  type StoreSetupActualScope,
  type StoreSetupDraft,
} from "../../contracts/store-setup-draft.js";
import { parseStoreAdministrationReference } from "../../contracts/store-configuration-administration.js";
import {
  createStoreSetupServiceModePreparation,
  createStoreSetupServiceModePreparationFromRecordedRevision,
} from "../../contracts/store-setup-service-mode-preparation.js";
import {
  StoreSetupOperationError,
  parseStoreSetupSaveCommand,
  parseStoreSetupResolveCommand,
  parseStoreSetupOperationReceipt,
  parseStoreSetupCurrent,
  parseStoreSetupIntentDigest,
  type StoreSetupSaveCommand,
  type StoreSetupResolveCommand,
  type StoreSetupOperationReceipt,
  type StoreSetupOperationScope,
} from "../../contracts/store-setup-operation.js";
export interface StoreSetupDraftTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export const storeSetupDraftOperationFields = Object.freeze([
  "identity",
  "scope",
  "revision",
  "partialContent",
  "currentDraft",
  "originalOperation",
  "audit",
  "defaultLocale",
  "currencyCode",
  "baseConfigurationReference",
] as const);
type Original = StoreSetupSaveCommand | StoreSetupResolveCommand;
type Mode = "Read" | "Save" | "Resolve";
export interface StoreSetupServiceModePreparationVersionSelector {
  readonly setupDraftReference: string;
  readonly sourceRevision: number;
  readonly sourceSnapshotDigest: string;
}
export interface StoreSetupDraftStoreOptions extends StoreSetupOperationScope {
  readonly transaction: StoreSetupDraftTransaction;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly registerBeforeCommit: (
    tx: StoreSetupDraftTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void> | void;
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: StoreSetupDraftTransaction,
      input: Readonly<
        StoreSetupOperationScope & {
          permission: "organization.manage";
          purposeCode: "STORE_SETUP_DRAFT";
          mode: Mode;
          requiredFields: typeof storeSetupDraftOperationFields;
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
    nextReference(kind: "SetupDraft" | "Audit"): string;
  };
  /** This callback is the actual public Audit writer in the same borrowed tx;
   * it must append the requested exact server metadata, not return a proof DTO. */
  readonly appendAudit: (
    tx: StoreSetupDraftTransaction,
    input: Readonly<
      StoreSetupOperationScope & {
        auditReference: string;
        operationReference: string;
        intentDigest: string;
        purposeCode: "STORE_SETUP_DRAFT";
        mode: "Save" | "Abandon";
        occurredAt: string;
      }
    >,
  ) => Promise<void>;
  /** Actual Tenant/Brand/Store owner sources and their COMMIT guards supply these
   * facts. Read/original replay never invokes today's authoring scope source. */
  readonly withCurrentSaveScope: <T>(
    tx: StoreSetupDraftTransaction,
    input: Readonly<StoreSetupOperationScope & { observedAt: string; validUntil: string }>,
    work: (actualScope: StoreSetupActualScope) => Promise<T>,
  ) => Promise<T>;
}
const utc = (value: string) =>
  `to_char(${value} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const revisionColumns = `setup_draft_id,revision::text revision,operation_id,actor_id,snapshot_json,snapshot_digest,${utc("created_at")} created_at,${utc("updated_at")} updated_at`;
/** Append-only setup only; no complete configuration, reference eligibility,
 * approval, publication or live gate is manufactured by this repository. */
export function createPostgresStoreSetupDraftStore(options: StoreSetupDraftStoreOptions) {
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
    auditPort = options.appendAudit,
    scopePort = options.withCurrentSaveScope;
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
    finalCalls = 0;
  let wroteTerminal = false;
  let operation: Original | null = null,
    heldSnapshot: StoreSetupDraft | null | undefined = undefined,
    originalReceipt: StoreSetupOperationReceipt | undefined;
  const modes = new Set<Mode>();
  const fail = (
    code: StoreSetupOperationError["code"] = "STORE_SETUP_OPERATION_DEPENDENCY_UNAVAILABLE",
  ): never => {
    failed = true;
    throw new StoreSetupOperationError(code);
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
      scopePort,
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
      options.withCurrentSaveScope !== scopePort
    )
      return fail();
    const at = parseCanonicalInstant(clockPort.call(clockOwner));
    if (at < latest || at >= deadline) return fail();
    latest = at;
    return at;
  };
  const digest = (value: unknown) => {
    check();
    const canonical = canonicalPort.call(referenceOwner, value);
    if (typeof canonical !== "string" || Buffer.byteLength(canonical, "utf8") > 2097152)
      return fail();
    const result = parseStoreSetupIntentDigest(hashPort.call(referenceOwner, canonical));
    check();
    return result;
  };
  const same = (left: unknown, right: unknown) =>
    canonicalPort.call(referenceOwner, left) === canonicalPort.call(referenceOwner, right);
  const rows = (value: unknown, maximum = 1): readonly Record<string, unknown>[] => {
    if (!value || typeof value !== "object") return fail();
    const d = Object.getOwnPropertyDescriptor(value, "rows");
    if (
      !d ||
      !("value" in d) ||
      !Array.isArray(d.value) ||
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
  const hold = async (mode: Mode) => {
    const at = check();
    const proof = await holdPort.call(
      authorityOwner,
      tx,
      Object.freeze({
        ...fixed,
        permission: "organization.manage",
        purposeCode: "STORE_SETUP_DRAFT",
        mode,
        requiredFields: storeSetupDraftOperationFields,
        command: operation,
        observedAt: at,
        validUntil: deadline,
      }),
    );
    const d =
      proof && typeof proof === "object"
        ? Object.getOwnPropertyDescriptor(proof, "validUntil")
        : undefined;
    if (!d || !("value" in d) || Reflect.ownKeys(proof).length !== 1) return fail();
    const until = parseCanonicalInstant(d.value);
    if (until < deadline) deadline = until;
    check();
  };
  const root = async () => {
    await restore();
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `StoreSetupRoot:${fixed.tenantReference}:${fixed.brandReference}:${fixed.storeReference}`,
    ]);
  };
  const decodeRevision = (row: Record<string, unknown>): StoreSetupDraft => {
    if (Reflect.ownKeys(row).length !== 8) return fail();
    const snapshot = parseStoreSetupDraft(row.snapshot_json);
    if (
      snapshot.tenantReference !== fixed.tenantReference ||
      snapshot.brandReference !== fixed.brandReference ||
      snapshot.storeReference !== fixed.storeReference ||
      row.setup_draft_id !== snapshot.setupDraftReference ||
      row.revision !== String(snapshot.revision) ||
      row.actor_id !== snapshot.authoredByReference ||
      row.created_at !== snapshot.createdAt ||
      row.updated_at !== snapshot.updatedAt ||
      snapshot.updatedAt > check() ||
      digest(snapshot) !== row.snapshot_digest
    )
      return fail();
    parseStoreAdministrationReference(row.operation_id);
    return snapshot;
  };
  const readLatest = async () => {
    const data = rows(
      await query(
        `SELECT ${revisionColumns} FROM rms_store.store_setup_draft_revision WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 ORDER BY revision DESC LIMIT 1`,
        [fixed.tenantReference, fixed.brandReference, fixed.storeReference],
      ),
    );
    return data[0] ? decodeRevision(data[0]) : null;
  };
  const heldRevisions = new Map<
    string,
    { selector: StoreSetupServiceModePreparationVersionSelector; snapshot: StoreSetupDraft }
  >();
  const parseVersionSelector = (
    value: unknown,
  ): StoreSetupServiceModePreparationVersionSelector => {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== 3
    )
      return fail("STORE_SETUP_OPERATION_INPUT_INVALID");
    const field = (key: string) => {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d?.enumerable || !("value" in d)) return fail("STORE_SETUP_OPERATION_INPUT_INVALID");
      return d.value;
    };
    const setupDraftReference = parseStoreAdministrationReference(field("setupDraftReference")),
      sourceRevision = field("sourceRevision"),
      sourceSnapshotDigest = parseStoreSetupIntentDigest(field("sourceSnapshotDigest"));
    if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 1 || sourceRevision > 2147483647)
      return fail("STORE_SETUP_OPERATION_INPUT_INVALID");
    return Object.freeze({ setupDraftReference, sourceRevision, sourceSnapshotDigest });
  };
  const readRecordedRevision = async (
    selector: StoreSetupServiceModePreparationVersionSelector,
  ) => {
    // The immutable revision must have its actual committed original tuple. The
    // original author can differ from today's authorized reader/reviewer.
    const data = rows(
      await query(
        `SELECT ${revisionColumns} FROM rms_store.store_setup_draft_revision r
       WHERE r.tenant_id=$1 AND r.brand_id=$2 AND r.store_id=$3
       AND r.setup_draft_id=$4 AND r.revision=$5
       AND EXISTS (SELECT 1 FROM rms_store.store_setup_draft_operation o
         WHERE o.operation_id=r.operation_id AND o.tenant_id=r.tenant_id
         AND o.brand_id=r.brand_id AND o.store_id=r.store_id AND o.actor_id=r.actor_id
         AND o.outcome='Committed' AND o.result_setup_id=r.setup_draft_id
         AND o.result_revision=r.revision AND o.snapshot_digest=r.snapshot_digest
         AND o.expected_revision=r.revision-1 AND o.occurred_at=r.updated_at
         AND ((r.revision=1 AND o.expected_setup_id IS NULL)
           OR (r.revision>1 AND o.expected_setup_id=r.setup_draft_id)))`,
        [
          fixed.tenantReference,
          fixed.brandReference,
          fixed.storeReference,
          selector.setupDraftReference,
          selector.sourceRevision,
        ],
      ),
    );
    if (!data[0]) return fail("STORE_SETUP_OPERATION_VERSION_CONFLICT");
    const snapshot = decodeRevision(data[0]);
    if (digest(snapshot) !== selector.sourceSnapshotDigest)
      return fail("STORE_SETUP_OPERATION_VERSION_CONFLICT");
    return snapshot;
  };
  const parseStored = async (row: Record<string, unknown>): Promise<StoreSetupOperationReceipt> => {
    if (Reflect.ownKeys(row).length !== 14) return fail();
    if (
      row.tenant_id !== fixed.tenantReference ||
      row.brand_id !== fixed.brandReference ||
      row.store_id !== fixed.storeReference ||
      row.actor_id !== fixed.actorReference
    )
      return fail("STORE_SETUP_OPERATION_PERMISSION_DENIED");
    const expectedRevision = Number(row.expected_revision);
    if (
      String(expectedRevision) !== row.expected_revision ||
      !Number.isSafeInteger(expectedRevision)
    )
      return fail();
    let snapshot: StoreSetupDraft | null = null;
    if (row.outcome === "Committed") {
      const found = rows(
        await query(
          `SELECT ${revisionColumns} FROM rms_store.store_setup_draft_revision WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND setup_draft_id=$4 AND revision=$5 AND operation_id=$6`,
          [
            fixed.tenantReference,
            fixed.brandReference,
            fixed.storeReference,
            row.result_setup_id,
            row.result_revision,
            row.operation_id,
          ],
        ),
      );
      if (!found[0]) return fail();
      snapshot = decodeRevision(found[0]);
      if (
        digest(snapshot) !== row.snapshot_digest ||
        String(snapshot.revision) !== row.result_revision
      )
        return fail();
    } else if (
      row.outcome !== "Abandoned" ||
      row.result_setup_id !== null ||
      row.result_revision !== null ||
      row.snapshot_digest !== null
    )
      return fail();
    const receipt = parseStoreSetupOperationReceipt({
      profile: "StoreSetupOperationReceiptV1",
      ...fixed,
      operationReference: row.operation_id,
      expectedSetupReference: row.expected_setup_id,
      expectedRevision,
      purposeCode: "STORE_SETUP_DRAFT",
      intentDigest: row.intent_digest,
      outcome: row.outcome,
      snapshot,
      auditReference: row.audit_reference,
      occurredAt: row.occurred_at,
    });
    if (receipt.occurredAt > check()) return fail();
    if (snapshot) {
      const reconstructed = parseStoreSetupSaveCommand({
        profile: snapshot.profile === "StoreSetupDraftV2" ? "StoreSetupSaveV2" : "StoreSetupSaveV1",
        ...fixed,
        operationReference: receipt.operationReference,
        expectedSetupReference: receipt.expectedSetupReference,
        expectedRevision: receipt.expectedRevision,
        purposeCode: "STORE_SETUP_DRAFT",
        content: snapshot.content,
      });
      if (digest(reconstructed) !== receipt.intentDigest) return fail();
    }
    return receipt;
  };
  const lookup = async (command: Original) => {
    const found = rows(
      await query(
        `SELECT operation_id,tenant_id,brand_id,store_id,actor_id,intent_digest,expected_setup_id,expected_revision::text expected_revision,outcome,result_setup_id,result_revision::text result_revision,snapshot_digest,audit_reference,${utc("occurred_at")} occurred_at FROM rms_store.store_setup_draft_operation WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4`,
        [
          fixed.tenantReference,
          fixed.brandReference,
          fixed.storeReference,
          command.operationReference,
        ],
      ),
    );
    if (!found[0]) return null;
    const receipt = await parseStored(found[0]);
    const requested =
      command.profile === "StoreSetupResolveV1" ? command.intentDigest : digest(command);
    if (
      receipt.intentDigest !== requested ||
      receipt.expectedSetupReference !== command.expectedSetupReference ||
      receipt.expectedRevision !== command.expectedRevision
    )
      return fail("STORE_SETUP_OPERATION_IDEMPOTENCY_CONFLICT");
    return receipt;
  };
  const append = async (command: Original, snapshot: StoreSetupDraft | null, at: string) => {
    const intent =
        command.profile === "StoreSetupResolveV1" ? command.intentDigest : digest(command),
      auditReference = parseStoreAdministrationReference(nextPort.call(referenceOwner, "Audit"));
    check();
    const appended = await auditPort.call(
      options,
      tx,
      Object.freeze({
        ...fixed,
        auditReference,
        operationReference: command.operationReference,
        intentDigest: intent,
        purposeCode: "STORE_SETUP_DRAFT",
        mode: snapshot === null ? "Abandon" : "Save",
        occurredAt: at,
      }),
    );
    if (appended !== undefined) return fail();
    check();
    await restore();
    await insert(
      "INSERT INTO rms_store.store_setup_draft_operation(operation_id,tenant_id,brand_id,store_id,actor_id,intent_digest,expected_setup_id,expected_revision,outcome,result_setup_id,result_revision,snapshot_digest,audit_reference,occurred_at,data_classification) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'ConfigurationMetadata')",
      [
        command.operationReference,
        fixed.tenantReference,
        fixed.brandReference,
        fixed.storeReference,
        fixed.actorReference,
        intent,
        command.expectedSetupReference,
        command.expectedRevision,
        snapshot ? "Committed" : "Abandoned",
        snapshot?.setupDraftReference ?? null,
        snapshot?.revision ?? null,
        snapshot ? digest(snapshot) : null,
        auditReference,
        at,
      ],
    );
    wroteTerminal = true;
    const receipt = parseStoreSetupOperationReceipt({
      profile: "StoreSetupOperationReceiptV1",
      ...fixed,
      operationReference: command.operationReference,
      expectedSetupReference: command.expectedSetupReference,
      expectedRevision: command.expectedRevision,
      purposeCode: "STORE_SETUP_DRAFT",
      intentDigest: intent,
      outcome: snapshot ? "Committed" : "Abandoned",
      snapshot,
      auditReference,
      occurredAt: at,
    });
    return receipt;
  };
  const admit = async (mode: Mode, command: Original | null) => {
    if (active || phase !== "Work") return fail();
    active = true;
    if (command) {
      if (
        Object.entries(fixed).some(
          ([key, value]) => Object.getOwnPropertyDescriptor(command, key)?.value !== value,
        )
      )
        return fail("STORE_SETUP_OPERATION_PERMISSION_DENIED");
      if (operation && !same(operation, command)) return fail();
      operation = command;
    }
    modes.add(mode);
    if (!registered) {
      registered = true;
      const value = await registerPort.call(
        options,
        tx,
        async () => {
          try {
            if (++guardCalls !== 1 || active || phase !== "Work") return fail();
            phase = "Checks";
            for (const mode of modes) await hold(mode);
            await root();
            if (heldSnapshot !== undefined) {
              const fresh = await readLatest();
              if (!same(fresh, heldSnapshot)) return fail("STORE_SETUP_OPERATION_VERSION_CONFLICT");
            }
            for (const { selector, snapshot } of heldRevisions.values()) {
              if (!same(await readRecordedRevision(selector), snapshot))
                return fail("STORE_SETUP_OPERATION_VERSION_CONFLICT");
            }
            if (originalReceipt && operation) {
              const fresh = await lookup(operation);
              if (!same(fresh, originalReceipt)) return fail();
            }
            await restore();
            if (wroteTerminal)
              await query(
                "SET CONSTRAINTS rms_store.store_setup_revision_coherence,rms_store.store_setup_operation_coherence IMMEDIATE",
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
    await hold(mode);
    await restore();
    const isolation = rows(
      await query("SELECT current_setting('transaction_isolation') isolation", []),
    );
    if (isolation.length !== 1 || isolation[0]?.isolation !== "read committed") return fail();
    if (command)
      await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "StoreSetupOperation:" + command.operationReference,
      ]);
    await root();
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
      if (error instanceof StoreSetupOperationError) throw error;
      if (
        error instanceof StoreSetupDraftError &&
        (error.code === "STORE_SETUP_VERSION_CONFLICT" ||
          error.code === "STORE_SETUP_SCOPE_MISMATCH")
      )
        return fail("STORE_SETUP_OPERATION_VERSION_CONFLICT");
      return fail();
    }
  };
  const readCurrentWork = async () => {
    await admit("Read", null);
    const snapshot = await readLatest();
    heldSnapshot = snapshot;
    await hold("Read");
    return parseStoreSetupCurrent({
      profile: "StoreSetupCurrentV1",
      tenantReference: fixed.tenantReference,
      brandReference: fixed.brandReference,
      storeReference: fixed.storeReference,
      readerActorReference: fixed.actorReference,
      snapshot,
      observedAt: check(),
      validUntil: deadline,
      businessReferenceValidation: "NotEvaluated",
    });
  };
  return Object.freeze({
    readCurrent: () => protect(readCurrentWork),
    /** The same held current source supplies preparation facts only. Its original
     * whole-snapshot COMMIT guard is retained; no live capability is inferred. */
    readServiceModePreparation: () =>
      protect(async () =>
        createStoreSetupServiceModePreparation(
          await readCurrentWork(),
          {
            canonicalize: (value) => canonicalPort.call(referenceOwner, value),
            hashIntent: (value) => hashPort.call(referenceOwner, value),
          },
          check(),
        ),
      ),
    /** Authenticates the exact immutable origin; this is a historical reading,
     * separate from the current preparation needed for semantic revalidation. */
    readServiceModePreparationVersion: (value: unknown) =>
      protect(async () => {
        const selector = parseVersionSelector(value);
        await admit("Read", null);
        const snapshot = await readRecordedRevision(selector);
        const key = `${selector.setupDraftReference}:${selector.sourceRevision}`;
        const old = heldRevisions.get(key);
        if (old && !same(old.selector, selector))
          return fail("STORE_SETUP_OPERATION_VERSION_CONFLICT");
        heldRevisions.set(key, { selector, snapshot });
        await hold("Read");
        const observedAt = check();
        const preparation = createStoreSetupServiceModePreparationFromRecordedRevision(
          {
            profile: "StoreSetupRecordedRevisionV1",
            tenantReference: fixed.tenantReference,
            brandReference: fixed.brandReference,
            storeReference: fixed.storeReference,
            readerActorReference: fixed.actorReference,
            snapshot,
            observedAt,
            validUntil: deadline,
            recordingStatus: "Recorded",
          },
          {
            canonicalize: (input) => canonicalPort.call(referenceOwner, input),
            hashIntent: (input) => hashPort.call(referenceOwner, input),
          },
          observedAt,
        );
        return Object.freeze({
          profile: "StoreSetupServiceModePreparationVersionV1" as const,
          sourceBasis: "RecordedDraftRevision" as const,
          readerActorReference: fixed.actorReference,
          preparation,
        });
      }),
    readFeeContextPreparation: () =>
      protect(async () =>
        createStoreSetupFeeContextPreparation(
          await readCurrentWork(),
          {
            canonicalize: (value) => canonicalPort.call(referenceOwner, value),
            hashIntent: (value) => hashPort.call(referenceOwner, value),
          },
          check(),
        ),
      ),
    /** Authenticates the exact immutable origin; this is a historical reading,
     * separate from the current preparation needed for semantic revalidation. */
    readFeeContextPreparationVersion: (value: unknown) =>
      protect(async () => {
        const selector = parseVersionSelector(value);
        await admit("Read", null);
        const snapshot = await readRecordedRevision(selector);
        const key = `${selector.setupDraftReference}:${selector.sourceRevision}`;
        const old = heldRevisions.get(key);
        if (old && !same(old.selector, selector))
          return fail("STORE_SETUP_OPERATION_VERSION_CONFLICT");
        heldRevisions.set(key, { selector, snapshot });
        await hold("Read");
        const observedAt = check();
        const preparation = createStoreSetupFeeContextPreparationFromRecordedRevision(
          {
            profile: "StoreSetupRecordedRevisionV1",
            tenantReference: fixed.tenantReference,
            brandReference: fixed.brandReference,
            storeReference: fixed.storeReference,
            readerActorReference: fixed.actorReference,
            snapshot,
            observedAt,
            validUntil: deadline,
            recordingStatus: "Recorded",
          },
          {
            canonicalize: (input) => canonicalPort.call(referenceOwner, input),
            hashIntent: (input) => hashPort.call(referenceOwner, input),
          },
          observedAt,
        );
        return Object.freeze({
          profile: "StoreSetupFeeContextPreparationVersionV1" as const,
          sourceBasis: "RecordedDraftRevision" as const,
          readerActorReference: fixed.actorReference,
          preparation,
        });
      }),
    save: (value: unknown) =>
      protect(async () => {
        const command = parseStoreSetupSaveCommand(value);
        await admit("Save", command);
        const old = await lookup(command);
        if (old) {
          originalReceipt = old;
          await hold("Save");
          return old;
        }
        const current = await readLatest();
        if (
          (current?.revision ?? 0) !== command.expectedRevision ||
          (current?.setupDraftReference ?? null) !== command.expectedSetupReference ||
          command.expectedRevision === 2147483647
        )
          return fail("STORE_SETUP_OPERATION_VERSION_CONFLICT");
        if (current?.profile === "StoreSetupDraftV2" && command.profile !== "StoreSetupSaveV2")
          return fail("STORE_SETUP_OPERATION_VERSION_CONFLICT");
        let calls = 0;
        const completion: { value?: { receipt: StoreSetupOperationReceipt } } = {};
        const returned = await scopePort.call(
          options,
          tx,
          Object.freeze({ ...fixed, observedAt: check(), validUntil: deadline }),
          async (actual) => {
            if (
              ++calls !== 1 ||
              Object.entries(fixed).some(
                ([key, v]) => Object.getOwnPropertyDescriptor(actual, key)?.value !== v,
              )
            )
              return fail("STORE_SETUP_OPERATION_PERMISSION_DENIED");
            check();
            const at = check(),
              snapshot = current
                ? replaceStoreSetupDraftContent(current, command.content, actual, {
                    expectedRevision: command.expectedRevision,
                    observedAt: at,
                  })
                : createStoreSetupDraft(
                    {
                      profile:
                        command.profile === "StoreSetupSaveV2"
                          ? "StoreSetupDraftV2"
                          : "StoreSetupDraftV1",
                      setupDraftReference: parseStoreAdministrationReference(
                        nextPort.call(referenceOwner, "SetupDraft"),
                      ),
                      tenantReference: fixed.tenantReference,
                      brandReference: fixed.brandReference,
                      storeReference: fixed.storeReference,
                      revision: 1,
                      authoredByReference: fixed.actorReference,
                      defaultLocale: actual.defaultLocale,
                      currencyCode: actual.currencyCode,
                      baseConfigurationReference: actual.baseConfigurationReference,
                      content: command.content,
                      createdAt: at,
                      updatedAt: at,
                      purposeCode: "STORE_SETUP_DRAFT",
                      dataClassification: "ConfigurationMetadata",
                    },
                    actual,
                  );
            await hold("Save");
            await restore();
            await insert(
              "INSERT INTO rms_store.store_setup_draft_revision(tenant_id,brand_id,store_id,setup_draft_id,revision,operation_id,actor_id,snapshot_json,snapshot_digest,created_at,updated_at,data_classification) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,'ConfigurationMetadata')",
              [
                fixed.tenantReference,
                fixed.brandReference,
                fixed.storeReference,
                snapshot.setupDraftReference,
                snapshot.revision,
                command.operationReference,
                fixed.actorReference,
                canonicalPort.call(referenceOwner, snapshot),
                digest(snapshot),
                snapshot.createdAt,
                snapshot.updatedAt,
              ],
            );
            const receipt = await append(command, snapshot, at);
            heldSnapshot = snapshot;
            originalReceipt = receipt;
            const result = { receipt };
            completion.value = result;
            return result;
          },
        );
        const completed = completion.value;
        if (calls !== 1 || !completed || returned !== completed) return fail();
        await hold("Save");
        return completed.receipt;
      }),
    resolve: (value: unknown) =>
      protect(async () => {
        const command = parseStoreSetupResolveCommand(value);
        await admit("Resolve", command);
        const old = await lookup(command);
        if (old) {
          originalReceipt = old;
          await hold("Resolve");
          return old;
        }
        const receipt = await append(command, null, check());
        originalReceipt = receipt;
        await hold("Resolve");
        return receipt;
      }),
    assertFinalized(actual: StoreSetupDraftTransaction): string {
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
