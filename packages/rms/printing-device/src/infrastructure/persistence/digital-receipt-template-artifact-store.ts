import { DigitalReceiptTemplateError } from "../../contracts/digital-receipt-template.js";
import { parseDeviceReference, parseDeviceInstant } from "../../contracts/device-management.js";
import {
  parseDigitalReceiptTemplateArtifactVersion,
  parseDigitalReceiptTemplateArtifactSave,
  parseDigitalReceiptTemplateArtifactResolve,
  parseDigitalReceiptTemplateArtifactReceipt,
  parseDigitalReceiptTemplateArtifactCurrent,
  type DigitalReceiptTemplateArtifactActorScope,
  digitalReceiptTemplateArtifactRequiredFields,
  type DigitalReceiptTemplateArtifactKind,
  type DigitalReceiptTemplateArtifactVersion,
  type DigitalReceiptTemplateArtifactSave,
  type DigitalReceiptTemplateArtifactResolve,
  type DigitalReceiptTemplateArtifactReceipt,
} from "../../contracts/digital-receipt-template-artifact.js";
export interface DigitalReceiptTemplateArtifactTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
const parseIntentDigest = (value: unknown): string => {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value))
    throw new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_UNAVAILABLE");
  return value;
};
type Original = DigitalReceiptTemplateArtifactSave | DigitalReceiptTemplateArtifactResolve;
type Mode = "ReadAll" | "ReadVersion" | "Save" | "Resolve";
export interface DigitalReceiptTemplateArtifactStoreOptions extends DigitalReceiptTemplateArtifactActorScope {
  readonly transaction: DigitalReceiptTemplateArtifactTransaction;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly registerBeforeCommit: (
    tx: DigitalReceiptTemplateArtifactTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void> | void;
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: DigitalReceiptTemplateArtifactTransaction,
      input: Readonly<
        DigitalReceiptTemplateArtifactActorScope & {
          permission: "organization.manage" | "integration.manage";
          purposeCode: "RECEIPT_TEMPLATE_ARTIFACT";
          mode: Mode;
          artifactKind: DigitalReceiptTemplateArtifactKind | null;
          targetArtifactReference: string | null;
          requiredFields: typeof digitalReceiptTemplateArtifactRequiredFields;
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
    nextReference(kind: "Artifact" | "Audit"): string;
  };
  readonly appendAudit: (
    tx: DigitalReceiptTemplateArtifactTransaction,
    input: Readonly<
      DigitalReceiptTemplateArtifactActorScope & {
        artifactKind: DigitalReceiptTemplateArtifactKind;
        operationReference: string;
        auditReference: string;
        intentDigest: string;
        purposeCode: "RECEIPT_TEMPLATE_ARTIFACT";
        mode: "Save" | "Abandon";
        occurredAt: string;
      }
    >,
  ) => Promise<void>;
}
const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const versionColumns = `artifact_kind,artifact_id,revision::text revision,operation_id,actor_id,previous_artifact_id,snapshot_json,snapshot_digest,${utc("created_at")} created_at,${utc("updated_at")} updated_at`;
/** Immutable fixed digital Layout/Compliance artifacts, not professional review,
 * legal conclusions, template publication or Store readiness. */
export function createPostgresDigitalReceiptTemplateArtifactStore(
  options: DigitalReceiptTemplateArtifactStoreOptions,
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
    tenantReference: parseDeviceReference(options.tenantReference),
    brandReference: parseDeviceReference(options.brandReference),
    storeReference: parseDeviceReference(options.storeReference),
    actorReference: parseDeviceReference(options.actorReference),
  };
  const origin = parseDeviceInstant(options.originalObservedAt),
    originalUntil = parseDeviceInstant(options.originalValidUntil);
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
  let historicalKind: DigitalReceiptTemplateArtifactKind | null = null,
    historicalReference: string | null = null,
    heldHistorical: DigitalReceiptTemplateArtifactVersion | null | undefined;
  let heldCurrent:
    | Readonly<{
        layout: DigitalReceiptTemplateArtifactVersion | null;
        compliance: DigitalReceiptTemplateArtifactVersion | null;
      }>
    | undefined;
  let heldWritten: DigitalReceiptTemplateArtifactVersion | undefined,
    originalReceipt: DigitalReceiptTemplateArtifactReceipt | undefined;
  const fail = (
    code: DigitalReceiptTemplateError["code"] = "RECEIPT_TEMPLATE_UNAVAILABLE",
  ): never => {
    failed = true;
    throw new DigitalReceiptTemplateError(code);
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
      options.appendAudit !== auditPort
    )
      return fail();
    const at = stored(() => parseDeviceInstant(clockPort.call(clockOwner)));
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
    const result = parseIntentDigest(hashPort.call(referenceOwner, canonical(value)));
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
        permission:
          mode === "ReadAll" || mode === "ReadVersion"
            ? "organization.manage"
            : "integration.manage",
        purposeCode: "RECEIPT_TEMPLATE_ARTIFACT",
        mode,
        artifactKind: command?.artifactKind ?? historicalKind,
        targetArtifactReference: mode === "ReadVersion" ? historicalReference : null,
        requiredFields: digitalReceiptTemplateArtifactRequiredFields,
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
    const until = stored(() => parseDeviceInstant(d.value));
    if (until < deadline) deadline = until;
    check();
  };
  const root = async (kind: DigitalReceiptTemplateArtifactKind) => {
    await restore();
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `ReceiptTemplateArtifactRoot:${fixed.tenantReference}:${fixed.brandReference}:${fixed.storeReference}:${kind}`,
    ]);
  };
  const roots = async () => {
    if (command) await root(command.artifactKind);
    else if (historicalKind) await root(historicalKind);
    else {
      await root("Layout");
      await root("Compliance");
    }
  };
  const decodeVersion = (
    row: Record<string, unknown>,
    kind: DigitalReceiptTemplateArtifactKind,
  ): DigitalReceiptTemplateArtifactVersion => {
    if (Reflect.ownKeys(row).length !== 10) return fail();
    const snapshot = stored(() => parseDigitalReceiptTemplateArtifactVersion(row.snapshot_json));
    if (
      snapshot.tenantReference !== fixed.tenantReference ||
      snapshot.brandReference !== fixed.brandReference ||
      snapshot.storeReference !== fixed.storeReference ||
      snapshot.artifactKind !== kind ||
      row.artifact_kind !== kind ||
      row.artifact_id !== snapshot.artifactReference ||
      row.revision !== String(snapshot.revision) ||
      row.actor_id !== snapshot.authoredByReference ||
      row.previous_artifact_id !== snapshot.previousArtifactReference ||
      row.created_at !== snapshot.createdAt ||
      row.updated_at !== snapshot.updatedAt ||
      snapshot.updatedAt > check() ||
      digest(snapshot) !== row.snapshot_digest
    )
      return fail();
    parseDeviceReference(row.operation_id);
    return snapshot;
  };
  const readLatest = async (kind: DigitalReceiptTemplateArtifactKind) => {
    await restore();
    const found = rows(
      await query(
        `SELECT ${versionColumns} FROM rms_device.digital_receipt_template_artifact_version WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND artifact_kind=$4 ORDER BY revision DESC LIMIT 1`,
        [fixed.tenantReference, fixed.brandReference, fixed.storeReference, kind],
      ),
    );
    return found[0] ? decodeVersion(found[0], kind) : null;
  };
  const readExact = async (kind: DigitalReceiptTemplateArtifactKind, reference: string) => {
    await restore();
    const found = rows(
      await query(
        `SELECT ${versionColumns} FROM rms_device.digital_receipt_template_artifact_version WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND artifact_kind=$4 AND artifact_id=$5`,
        [fixed.tenantReference, fixed.brandReference, fixed.storeReference, kind, reference],
      ),
    );
    if (!found[0]) return null;
    const snapshot = decodeVersion(found[0], kind);
    if (snapshot.artifactReference !== reference) return fail();
    return snapshot;
  };
  const lookup = async (
    original: Original,
  ): Promise<DigitalReceiptTemplateArtifactReceipt | null> => {
    await restore();
    const found = rows(
      await query(
        `SELECT operation_id,tenant_id,brand_id,store_id,artifact_kind,actor_id,intent_digest,expected_artifact_id,expected_revision::text expected_revision,outcome,result_artifact_id,result_revision::text result_revision,snapshot_digest,audit_reference,${utc("occurred_at")} occurred_at FROM rms_device.digital_receipt_template_artifact_operation WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4`,
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
      row.actor_id !== fixed.actorReference
    )
      return fail("RECEIPT_TEMPLATE_PERMISSION_DENIED");
    if (row.artifact_kind !== original.artifactKind) return fail("RECEIPT_TEMPLATE_CONFLICT");
    const expectedRevision = Number(row.expected_revision);
    if (
      !Number.isSafeInteger(expectedRevision) ||
      String(expectedRevision) !== row.expected_revision
    )
      return fail();
    let snapshot: DigitalReceiptTemplateArtifactVersion | null = null;
    if (row.outcome === "Committed") {
      const versions = rows(
        await query(
          `SELECT ${versionColumns} FROM rms_device.digital_receipt_template_artifact_version WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND artifact_kind=$4 AND artifact_id=$5 AND revision=$6 AND operation_id=$7`,
          [
            fixed.tenantReference,
            fixed.brandReference,
            fixed.storeReference,
            original.artifactKind,
            row.result_artifact_id,
            row.result_revision,
            row.operation_id,
          ],
        ),
      );
      if (!versions[0] || versions[0].operation_id !== row.operation_id) return fail();
      snapshot = decodeVersion(versions[0], original.artifactKind);
      if (
        snapshot.artifactReference !== row.result_artifact_id ||
        digest(snapshot) !== row.snapshot_digest ||
        String(snapshot.revision) !== row.result_revision
      )
        return fail();
    } else if (
      row.outcome !== "Abandoned" ||
      row.result_artifact_id !== null ||
      row.result_revision !== null ||
      row.snapshot_digest !== null
    )
      return fail();
    const receipt = stored(() =>
      parseDigitalReceiptTemplateArtifactReceipt({
        profile: "DigitalReceiptTemplateArtifactReceiptV1",
        ...fixed,
        artifactKind: original.artifactKind,
        operationReference: row.operation_id,
        expectedArtifactReference: row.expected_artifact_id,
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
        parseDigitalReceiptTemplateArtifactSave({
          profile: "DigitalReceiptTemplateArtifactSaveV1",
          ...fixed,
          artifactKind: persisted.artifactKind,
          operationReference: receipt.operationReference,
          expectedArtifactReference: receipt.expectedArtifactReference,
          expectedRevision: receipt.expectedRevision,
          purposeCode: "RECEIPT_TEMPLATE_ARTIFACT",
          content: persisted.content,
        }),
      );
      if (digest(originalSave) !== receipt.intentDigest) return fail();
    }
    const requested =
      original.profile === "DigitalReceiptTemplateArtifactSaveV1"
        ? digest(original)
        : original.intentDigest;
    if (
      receipt.intentDigest !== requested ||
      receipt.expectedArtifactReference !== original.expectedArtifactReference ||
      receipt.expectedRevision !== original.expectedRevision
    )
      return fail("RECEIPT_TEMPLATE_CONFLICT");
    return receipt;
  };
  const append = async (
    original: Original,
    snapshot: DigitalReceiptTemplateArtifactVersion | null,
    at: string,
  ) => {
    const intentDigest =
      original.profile === "DigitalReceiptTemplateArtifactSaveV1"
        ? digest(original)
        : original.intentDigest;
    const auditReference = parseDeviceReference(nextPort.call(referenceOwner, "Audit"));
    check();
    const returned = await auditPort.call(
      options,
      tx,
      Object.freeze({
        ...fixed,
        artifactKind: original.artifactKind,
        operationReference: original.operationReference,
        auditReference,
        intentDigest,
        purposeCode: "RECEIPT_TEMPLATE_ARTIFACT",
        mode: snapshot ? "Save" : "Abandon",
        occurredAt: at,
      }),
    );
    if (returned !== undefined) return fail();
    check();
    await restore();
    await insert(
      "INSERT INTO rms_device.digital_receipt_template_artifact_operation(operation_id,tenant_id,brand_id,store_id,artifact_kind,actor_id,intent_digest,expected_artifact_id,expected_revision,outcome,result_artifact_id,result_revision,snapshot_digest,audit_reference,occurred_at,data_classification) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'Internal')",
      [
        original.operationReference,
        fixed.tenantReference,
        fixed.brandReference,
        fixed.storeReference,
        original.artifactKind,
        fixed.actorReference,
        intentDigest,
        original.expectedArtifactReference,
        original.expectedRevision,
        snapshot ? "Committed" : "Abandoned",
        snapshot?.artifactReference ?? null,
        snapshot?.revision ?? null,
        snapshot ? digest(snapshot) : null,
        auditReference,
        at,
      ],
    );
    wroteTerminal = true;
    return parseDigitalReceiptTemplateArtifactReceipt({
      profile: "DigitalReceiptTemplateArtifactReceiptV1",
      ...fixed,
      artifactKind: original.artifactKind,
      operationReference: original.operationReference,
      expectedArtifactReference: original.expectedArtifactReference,
      expectedRevision: original.expectedRevision,
      intentDigest,
      outcome: snapshot ? "Committed" : "Abandoned",
      snapshot,
      auditReference,
      occurredAt: at,
    });
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
        return fail("RECEIPT_TEMPLATE_PERMISSION_DENIED");
      if (command && !same(command, original)) return fail("RECEIPT_TEMPLATE_CONFLICT");
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
                layout: await readLatest("Layout"),
                compliance: await readLatest("Compliance"),
              };
              if (!same(current, heldCurrent)) return fail("RECEIPT_TEMPLATE_CONFLICT");
            }
            if (heldHistorical !== undefined) {
              if (
                historicalKind === null ||
                historicalReference === null ||
                !same(await readExact(historicalKind, historicalReference), heldHistorical)
              )
                return fail();
            }
            if (heldWritten) {
              const current = await readLatest(heldWritten.artifactKind);
              if (!same(current, heldWritten)) return fail("RECEIPT_TEMPLATE_CONFLICT");
            }
            if (originalReceipt && command) {
              const current = await lookup(command);
              if (!same(current, originalReceipt)) return fail();
            }
            await restore();
            if (wroteTerminal)
              await query(
                "SET CONSTRAINTS rms_device.digital_receipt_template_artifact_version_coherence,rms_device.digital_receipt_template_artifact_operation_coherence IMMEDIATE",
                [],
              );
            check();
            guardComplete = true;
          } catch (error) {
            failed = true;
            if (error instanceof DigitalReceiptTemplateError) throw error;
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
        "ReceiptTemplateArtifactOperation:" + original.operationReference,
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
      if (error instanceof DigitalReceiptTemplateError) throw error;
      return fail();
    }
  };
  return Object.freeze({
    readCurrent: () =>
      protect(async () => {
        await admit("ReadAll", null);
        const current = Object.freeze({
          layout: await readLatest("Layout"),
          compliance: await readLatest("Compliance"),
        });
        heldCurrent = current;
        await hold();
        return parseDigitalReceiptTemplateArtifactCurrent({
          profile: "DigitalReceiptTemplateArtifactsCurrentV1",
          ...fixed,
          ...current,
          observedAt: check(),
          validUntil: deadline,
          sourceQualification: "NotEvaluated",
        });
      }),
    readVersion: (value: unknown) =>
      protect(async () => {
        let kind: DigitalReceiptTemplateArtifactKind, reference: string;
        try {
          if (
            !value ||
            typeof value !== "object" ||
            Object.getPrototypeOf(value) !== Object.prototype ||
            Reflect.ownKeys(value).length !== 2
          )
            throw new Error("invalid request");
          const kd = Object.getOwnPropertyDescriptor(value, "artifactKind"),
            rd = Object.getOwnPropertyDescriptor(value, "artifactReference");
          if (
            !kd?.enumerable ||
            !("value" in kd) ||
            !rd?.enumerable ||
            !("value" in rd) ||
            (kd.value !== "Layout" && kd.value !== "Compliance")
          )
            throw new Error("invalid request");
          kind = kd.value;
          reference = parseDeviceReference(rd.value);
        } catch {
          return fail("RECEIPT_TEMPLATE_INPUT_INVALID");
        }
        if (
          mode !== null &&
          (mode !== "ReadVersion" || historicalKind !== kind || historicalReference !== reference)
        )
          return fail();
        historicalKind = kind;
        historicalReference = reference;
        await admit("ReadVersion", null);
        const snapshot = await readExact(kind, reference);
        heldHistorical = snapshot;
        await hold();
        return snapshot;
      }),
    save: (value: unknown) =>
      protect(async () => {
        const original = parseDigitalReceiptTemplateArtifactSave(value);
        await admit("Save", original);
        const old = await lookup(original);
        if (old) {
          originalReceipt = old;
          await hold();
          return old;
        }
        const prior = await readLatest(original.artifactKind);
        if (
          (prior?.revision ?? 0) !== original.expectedRevision ||
          (prior?.artifactReference ?? null) !== original.expectedArtifactReference
        )
          return fail("RECEIPT_TEMPLATE_CONFLICT");
        const reference = parseDeviceReference(nextPort.call(referenceOwner, "Artifact"));
        check();
        if (reference === prior?.artifactReference) return fail();
        const at = check();
        const snapshot = parseDigitalReceiptTemplateArtifactVersion({
          profile: "DigitalReceiptTemplateArtifactV1",
          tenantReference: fixed.tenantReference,
          brandReference: fixed.brandReference,
          storeReference: fixed.storeReference,
          artifactKind: original.artifactKind,
          artifactReference: reference,
          revision: original.expectedRevision + 1,
          authoredByReference: fixed.actorReference,
          previousArtifactReference: prior?.artifactReference ?? null,
          content: original.content,
          createdAt: prior?.createdAt ?? at,
          updatedAt: at,
          dataClassification: "Internal",
        });
        await hold();
        await restore();
        await insert(
          "INSERT INTO rms_device.digital_receipt_template_artifact_version(tenant_id,brand_id,store_id,artifact_kind,artifact_id,revision,operation_id,actor_id,previous_artifact_id,snapshot_json,snapshot_digest,created_at,updated_at,data_classification) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,'Internal')",
          [
            fixed.tenantReference,
            fixed.brandReference,
            fixed.storeReference,
            original.artifactKind,
            reference,
            snapshot.revision,
            original.operationReference,
            fixed.actorReference,
            snapshot.previousArtifactReference,
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
        const original = parseDigitalReceiptTemplateArtifactResolve(value);
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
    assertFinalized(actual: DigitalReceiptTemplateArtifactTransaction): string {
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
