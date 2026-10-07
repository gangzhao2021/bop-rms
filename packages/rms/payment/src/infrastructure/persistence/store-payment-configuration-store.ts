import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
import {
  parsePaymentInstant,
  parsePaymentDigest,
  exactPaymentObject,
} from "../../application/payment-intent-creation.js";
import {
  parseStorePaymentConfigurationVersion,
  parseStorePaymentConfigurationSave,
  parseStorePaymentConfigurationResolve,
  parseStorePaymentConfigurationReceipt,
  parseStorePaymentConfigurationCurrent,
  StorePaymentConfigurationError,
  storePaymentConfigurationRequiredFields,
  type StorePaymentConfigurationActorScope,
  type StorePaymentConfigurationVersion,
  type StorePaymentConfigurationSave,
  type StorePaymentConfigurationResolve,
  type StorePaymentConfigurationReceipt,
} from "../../contracts/store-payment-configuration.js";

export interface StorePaymentConfigurationTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
type Original = StorePaymentConfigurationSave | StorePaymentConfigurationResolve;
type Mode = "ReadCurrent" | "ReadVersion" | "Save" | "Resolve";
export interface StorePaymentConfigurationStoreOptions extends StorePaymentConfigurationActorScope {
  readonly currencyCode: "CAD";
  readonly transaction: StorePaymentConfigurationTransaction;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly registerBeforeCommit: (
    tx: StorePaymentConfigurationTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void> | void;
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: StorePaymentConfigurationTransaction,
      input: Readonly<
        StorePaymentConfigurationActorScope & {
          currencyCode: "CAD";
          permission: "organization.manage";
          purposeCode: "STORE_PAYMENT_CONFIGURATION";
          mode: Mode;
          requiredFields: typeof storePaymentConfigurationRequiredFields;
          command: Original | null;
          configurationReference: string | null;
          observedAt: string;
          validUntil: string;
        }
      >,
    ): Promise<{ readonly validUntil: string }>;
  };
  readonly references: {
    canonicalize(value: unknown): string;
    hashIntent(value: string): string;
    nextReference(kind: "Configuration" | "Audit"): string;
  };
  readonly appendAudit: (
    tx: StorePaymentConfigurationTransaction,
    input: Readonly<
      StorePaymentConfigurationActorScope & {
        operationReference: string;
        auditReference: string;
        intentDigest: string;
        purposeCode: "STORE_PAYMENT_CONFIGURATION";
        mode: "Save" | "Abandon";
        occurredAt: string;
      }
    >,
  ) => Promise<void>;
}
const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const versionColumns = `configuration_id,revision::text revision,operation_id,actor_id,previous_configuration_id,snapshot_json,snapshot_digest,${utc("created_at")} created_at,${utc("updated_at")} updated_at`;
/** Immutable Store payment rules; neither current nor historical reads establish
 * Provider readiness or activate a later configuration in an approved Store. */
export function createPostgresStorePaymentConfigurationStore(
  options: StorePaymentConfigurationStoreOptions,
) {
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
    tenantReference: parsePaymentReference(options.tenantReference),
    brandReference: parsePaymentReference(options.brandReference),
    storeReference: parsePaymentReference(options.storeReference),
    actorReference: parsePaymentReference(options.actorReference),
  };
  const origin = parsePaymentInstant(options.originalObservedAt),
    originalUntil = parsePaymentInstant(options.originalValidUntil);
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
    mode: Mode | null = null,
    configurationReference: string | null = null;
  let heldCurrent: StorePaymentConfigurationVersion | null | undefined,
    heldHistorical: StorePaymentConfigurationVersion | null | undefined,
    heldWritten: StorePaymentConfigurationVersion | undefined,
    originalReceipt: StorePaymentConfigurationReceipt | undefined;
  const fail = (
    code: StorePaymentConfigurationError["code"] = "STORE_PAYMENT_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
  ): never => {
    failed = true;
    throw new StorePaymentConfigurationError(code);
  };
  const stored = <T>(read: () => T): T => {
    try {
      return read();
    } catch {
      return fail();
    }
  };
  if (
    options.currencyCode !== "CAD" ||
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
      options.currencyCode !== "CAD" ||
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
      options.appendAudit !== auditPort
    )
      return fail();
    const at = stored(() => parsePaymentInstant(clockPort.call(clockOwner)));
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
    const result = stored(() =>
      parsePaymentDigest(hashPort.call(referenceOwner, canonical(value))),
    );
    check();
    return result;
  };
  const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
  const rows = (value: unknown): readonly Readonly<Record<string, unknown>>[] => {
    if (!value || typeof value !== "object") return fail();
    const d = Object.getOwnPropertyDescriptor(value, "rows");
    if (
      !d?.enumerable ||
      !("value" in d) ||
      !Array.isArray(d.value) ||
      Object.getPrototypeOf(d.value) !== Array.prototype ||
      d.value.length > 1 ||
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
        Object.getPrototypeOf(row.value) !== Object.prototype
      )
        return fail();
      const keys = Reflect.ownKeys(row.value);
      if (keys.some((key) => typeof key !== "string")) return fail();
      return stored(() => exactPaymentObject(row.value, Object.keys(row.value)));
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
    const result = await query(sql, values),
      count =
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
        currencyCode: "CAD",
        permission: "organization.manage",
        purposeCode: "STORE_PAYMENT_CONFIGURATION",
        mode,
        requiredFields: storePaymentConfigurationRequiredFields,
        command,
        configurationReference: mode === "ReadVersion" ? configurationReference : null,
        observedAt: check(),
        validUntil: deadline,
      }),
    );
    const result = stored(() => exactPaymentObject(proof, ["validUntil"])),
      until = stored(() => parsePaymentInstant(result.validUntil));
    if (until < deadline) deadline = until;
    check();
  };
  const root = async () => {
    await restore();
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `StorePaymentConfigurationRoot:${fixed.tenantReference}:${fixed.brandReference}:${fixed.storeReference}`,
    ]);
  };
  const decodeVersion = (row: Readonly<Record<string, unknown>>) => {
    if (Reflect.ownKeys(row).length !== 9) return fail();
    const snapshot = stored(() => parseStorePaymentConfigurationVersion(row.snapshot_json));
    if (
      snapshot.tenantReference !== fixed.tenantReference ||
      snapshot.brandReference !== fixed.brandReference ||
      snapshot.storeReference !== fixed.storeReference ||
      snapshot.currencyCode !== "CAD" ||
      row.configuration_id !== snapshot.configurationReference ||
      row.revision !== String(snapshot.revision) ||
      row.actor_id !== snapshot.authoredByReference ||
      row.previous_configuration_id !== snapshot.previousConfigurationReference ||
      row.created_at !== snapshot.createdAt ||
      row.updated_at !== snapshot.updatedAt ||
      snapshot.updatedAt > check() ||
      digest(snapshot) !== row.snapshot_digest
    )
      return fail();
    return Object.freeze({
      snapshot,
      operationReference: stored(() => parsePaymentReference(row.operation_id)),
    });
  };
  const readLatest = async () => {
    await restore();
    const found = rows(
      await query(
        `SELECT ${versionColumns} FROM rms_payment.store_payment_configuration_version WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 ORDER BY revision DESC LIMIT 1`,
        [fixed.tenantReference, fixed.brandReference, fixed.storeReference],
      ),
    );
    return found[0] ? decodeVersion(found[0]).snapshot : null;
  };
  const readExact = async (reference: string) => {
    await restore();
    const found = rows(
      await query(
        `SELECT ${versionColumns} FROM rms_payment.store_payment_configuration_version WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND configuration_id=$4`,
        [fixed.tenantReference, fixed.brandReference, fixed.storeReference, reference],
      ),
    );
    if (!found[0]) return null;
    const result = decodeVersion(found[0]);
    if (result.snapshot.configurationReference !== reference) return fail();
    return result;
  };
  const lookup = async (original: Original): Promise<StorePaymentConfigurationReceipt | null> => {
    await restore();
    const found = rows(
      await query(
        `SELECT operation_id,tenant_id,brand_id,store_id,actor_id,intent_digest,expected_configuration_id,expected_revision::text expected_revision,outcome,result_configuration_id,result_revision::text result_revision,snapshot_digest,audit_reference,${utc("occurred_at")} occurred_at FROM rms_payment.store_payment_configuration_operation WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4`,
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
    if (Reflect.ownKeys(row).length !== 14 || row.operation_id !== original.operationReference)
      return fail();
    if (
      row.tenant_id !== fixed.tenantReference ||
      row.brand_id !== fixed.brandReference ||
      row.store_id !== fixed.storeReference ||
      row.actor_id !== fixed.actorReference
    )
      return fail("STORE_PAYMENT_CONFIGURATION_PERMISSION_DENIED");
    const expectedRevision = Number(row.expected_revision);
    if (
      !Number.isSafeInteger(expectedRevision) ||
      String(expectedRevision) !== row.expected_revision
    )
      return fail();
    let snapshot: StorePaymentConfigurationVersion | null = null;
    if (row.outcome === "Committed") {
      const actual = await readExact(
        stored(() => parsePaymentReference(row.result_configuration_id)),
      );
      if (
        !actual ||
        actual.operationReference !== original.operationReference ||
        String(actual.snapshot.revision) !== row.result_revision ||
        digest(actual.snapshot) !== row.snapshot_digest
      )
        return fail();
      snapshot = actual.snapshot;
    } else if (
      row.outcome !== "Abandoned" ||
      row.result_configuration_id !== null ||
      row.result_revision !== null ||
      row.snapshot_digest !== null
    )
      return fail();
    const receipt = stored(() =>
      parseStorePaymentConfigurationReceipt({
        profile: "StorePaymentConfigurationReceiptV1",
        ...fixed,
        operationReference: row.operation_id,
        intentDigest: row.intent_digest,
        expectedConfigurationReference: row.expected_configuration_id,
        expectedRevision,
        outcome: row.outcome,
        snapshot,
        auditReference: row.audit_reference,
        occurredAt: row.occurred_at,
      }),
    );
    if (receipt.occurredAt > check()) return fail();
    if (snapshot) {
      const persisted = snapshot,
        actualOriginal = stored(() =>
          parseStorePaymentConfigurationSave({
            profile: "StorePaymentConfigurationSaveV1",
            ...fixed,
            operationReference: receipt.operationReference,
            expectedConfigurationReference: receipt.expectedConfigurationReference,
            expectedRevision: receipt.expectedRevision,
            content: persisted.content,
            purposeCode: "STORE_PAYMENT_CONFIGURATION",
          }),
        );
      if (digest(actualOriginal) !== receipt.intentDigest) return fail();
    }
    const requested =
      original.profile === "StorePaymentConfigurationSaveV1"
        ? digest(original)
        : original.intentDigest;
    if (
      receipt.intentDigest !== requested ||
      receipt.expectedConfigurationReference !== original.expectedConfigurationReference ||
      receipt.expectedRevision !== original.expectedRevision
    )
      return fail("STORE_PAYMENT_CONFIGURATION_IDEMPOTENCY_CONFLICT");
    return receipt;
  };
  const append = async (
    original: Original,
    snapshot: StorePaymentConfigurationVersion | null,
    at: string,
  ) => {
    const intentDigest =
        original.profile === "StorePaymentConfigurationSaveV1"
          ? digest(original)
          : original.intentDigest,
      auditReference = stored(() => parsePaymentReference(nextPort.call(referenceOwner, "Audit")));
    check();
    const returned = await auditPort.call(
      options,
      tx,
      Object.freeze({
        ...fixed,
        operationReference: original.operationReference,
        auditReference,
        intentDigest,
        purposeCode: "STORE_PAYMENT_CONFIGURATION",
        mode: snapshot ? "Save" : "Abandon",
        occurredAt: at,
      }),
    );
    if (returned !== undefined) return fail();
    check();
    await restore();
    await insert(
      "INSERT INTO rms_payment.store_payment_configuration_operation(operation_id,tenant_id,brand_id,store_id,actor_id,intent_digest,expected_configuration_id,expected_revision,outcome,result_configuration_id,result_revision,snapshot_digest,audit_reference,occurred_at,data_classification) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'Internal')",
      [
        original.operationReference,
        fixed.tenantReference,
        fixed.brandReference,
        fixed.storeReference,
        fixed.actorReference,
        intentDigest,
        original.expectedConfigurationReference,
        original.expectedRevision,
        snapshot ? "Committed" : "Abandoned",
        snapshot?.configurationReference ?? null,
        snapshot?.revision ?? null,
        snapshot ? digest(snapshot) : null,
        auditReference,
        at,
      ],
    );
    wroteTerminal = true;
    return parseStorePaymentConfigurationReceipt({
      profile: "StorePaymentConfigurationReceiptV1",
      ...fixed,
      operationReference: original.operationReference,
      intentDigest,
      expectedConfigurationReference: original.expectedConfigurationReference,
      expectedRevision: original.expectedRevision,
      outcome: snapshot ? "Committed" : "Abandoned",
      snapshot,
      auditReference,
      occurredAt: at,
    });
  };
  const admit = async (
    selected: Mode,
    original: Original | null,
    reference: string | null = null,
  ) => {
    if (
      active ||
      phase !== "Work" ||
      (mode !== null && mode !== selected) ||
      (mode === "ReadVersion" && configurationReference !== reference)
    )
      return fail();
    active = true;
    mode = selected;
    configurationReference = reference;
    if (original) {
      if (
        Object.entries(fixed).some(
          ([key, value]) => Object.getOwnPropertyDescriptor(original, key)?.value !== value,
        )
      )
        return fail("STORE_PAYMENT_CONFIGURATION_PERMISSION_DENIED");
      if (command && !same(command, original))
        return fail("STORE_PAYMENT_CONFIGURATION_IDEMPOTENCY_CONFLICT");
      command = original;
    }
    if (!registered) {
      registered = true;
      const returned = await registerPort.call(
        options,
        tx,
        async () => {
          try {
            if (++guardCalls !== 1 || active || phase !== "Work") return fail();
            phase = "Checks";
            await hold();
            await root();
            if (heldCurrent !== undefined && !same(await readLatest(), heldCurrent))
              return fail("STORE_PAYMENT_CONFIGURATION_VERSION_CONFLICT");
            if (heldHistorical !== undefined) {
              if (
                configurationReference === null ||
                !same((await readExact(configurationReference))?.snapshot ?? null, heldHistorical)
              )
                return fail();
            }
            if (heldWritten && !same(await readLatest(), heldWritten))
              return fail("STORE_PAYMENT_CONFIGURATION_VERSION_CONFLICT");
            if (originalReceipt && command && !same(await lookup(command), originalReceipt))
              return fail();
            await restore();
            if (wroteTerminal)
              await query(
                "SET CONSTRAINTS rms_payment.store_payment_configuration_version_coherence,rms_payment.store_payment_configuration_operation_coherence IMMEDIATE",
                [],
              );
            check();
            guardComplete = true;
          } catch (error) {
            failed = true;
            if (error instanceof StorePaymentConfigurationError) throw error;
            return fail();
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
      if (returned !== undefined) return fail();
    }
    await hold();
    await restore();
    const isolation = rows(
      await query("SELECT current_setting('transaction_isolation') isolation", []),
    );
    if (isolation.length !== 1 || isolation[0]?.isolation !== "read committed") return fail();
    if (original)
      await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "StorePaymentConfigurationOperation:" + original.operationReference,
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
      if (error instanceof StorePaymentConfigurationError) throw error;
      return fail();
    }
  };
  return Object.freeze({
    readCurrent: () =>
      protect(async () => {
        await admit("ReadCurrent", null);
        const snapshot = await readLatest();
        heldCurrent = snapshot;
        await hold();
        return parseStorePaymentConfigurationCurrent({
          profile: "StorePaymentConfigurationCurrentV1",
          ...fixed,
          snapshot,
          observedAt: check(),
          validUntil: deadline,
          providerReadiness: "NotEvaluated",
        });
      }),
    readVersion: (value: unknown) =>
      protect(async () => {
        let reference: string;
        try {
          reference = parsePaymentReference(value);
        } catch {
          return fail("STORE_PAYMENT_CONFIGURATION_INPUT_INVALID");
        }
        await admit("ReadVersion", null, reference);
        const snapshot = (await readExact(reference))?.snapshot ?? null;
        heldHistorical = snapshot;
        await hold();
        return snapshot;
      }),
    save: (value: unknown) =>
      protect(async () => {
        const original = parseStorePaymentConfigurationSave(value);
        await admit("Save", original);
        const old = await lookup(original);
        if (old) {
          originalReceipt = old;
          await hold();
          return old;
        }
        const prior = await readLatest();
        if (
          (prior?.revision ?? 0) !== original.expectedRevision ||
          (prior?.configurationReference ?? null) !== original.expectedConfigurationReference
        )
          return fail("STORE_PAYMENT_CONFIGURATION_VERSION_CONFLICT");
        const reference = stored(() =>
          parsePaymentReference(nextPort.call(referenceOwner, "Configuration")),
        );
        check();
        if (reference === prior?.configurationReference) return fail();
        const at = check();
        const snapshot = parseStorePaymentConfigurationVersion({
          profile: "StorePaymentConfigurationV1",
          tenantReference: fixed.tenantReference,
          brandReference: fixed.brandReference,
          storeReference: fixed.storeReference,
          configurationReference: reference,
          revision: original.expectedRevision + 1,
          authoredByReference: fixed.actorReference,
          previousConfigurationReference: prior?.configurationReference ?? null,
          content: original.content,
          currencyCode: "CAD",
          createdAt: prior?.createdAt ?? at,
          updatedAt: at,
          dataClassification: "Internal",
        });
        await hold();
        await restore();
        await insert(
          "INSERT INTO rms_payment.store_payment_configuration_version(tenant_id,brand_id,store_id,configuration_id,revision,operation_id,actor_id,previous_configuration_id,snapshot_json,snapshot_digest,created_at,updated_at,data_classification) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,'Internal')",
          [
            fixed.tenantReference,
            fixed.brandReference,
            fixed.storeReference,
            reference,
            snapshot.revision,
            original.operationReference,
            fixed.actorReference,
            snapshot.previousConfigurationReference,
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
        const original = parseStorePaymentConfigurationResolve(value);
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
    assertFinalized(actual: StorePaymentConfigurationTransaction): string {
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
