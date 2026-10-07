import {
  parseRecordedPublishingMutation,
  evaluatePublishingTransition,
  type CommitPublishingMutationInput,
} from "@bop/publishing";
import {
  parseDigitalReceiptTemplateSubmission,
  type DigitalReceiptTemplateSubmission,
} from "../../contracts/digital-receipt-template-submission.js";
import { DigitalReceiptTemplateError } from "../../contracts/digital-receipt-template.js";
import { parseDeviceReference, parseDeviceInstant } from "../../contracts/device-management.js";
import {
  parseDigitalReceiptTemplateDraft,
  parseDigitalReceiptTemplateDraftSave,
  parseDigitalReceiptTemplateDraftResolve,
  parseDigitalReceiptTemplateDraftReceipt,
  parseDigitalReceiptTemplateDraftCurrent,
  parseDigitalReceiptTemplateDraftRoster,
  type DigitalReceiptTemplateDraft,
  type DigitalReceiptTemplateDraftActorScope,
  type DigitalReceiptTemplateDraftSave,
  type DigitalReceiptTemplateDraftResolve,
  type DigitalReceiptTemplateDraftReceipt,
} from "../../contracts/digital-receipt-template-draft.js";
import { createDigitalReceiptTemplateDraftContent } from "../../contracts/digital-receipt-template-draft-fields.js";
import {
  parseDigitalReceiptTemplateArtifactVersion,
  type DigitalReceiptTemplateArtifactVersion,
  type DigitalReceiptTemplateArtifactKind,
} from "../../contracts/digital-receipt-template-artifact.js";
export interface DigitalReceiptTemplateDraftTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
type Original = DigitalReceiptTemplateDraftSave | DigitalReceiptTemplateDraftResolve;
type Mode = "ReadRoster" | "ReadCurrent" | "ReadVersion" | "Save" | "Resolve";
export const digitalReceiptTemplateDraftRequiredFields = Object.freeze([
  "tenantReference",
  "brandReference",
  "storeReference",
  "actorReference",
  "templateReference",
  "familyReference",
  "versionReference",
  "revision",
  "operationReference",
  "expectedVersionReference",
  "expectedRevision",
  "fields",
  "intentDigest",
  "snapshot",
  "auditReference",
  "occurredAt",
] as const);
export interface DigitalReceiptTemplatePublicationSequence {
  readonly profile: "DigitalReceiptTemplatePublicationSequenceV1";
  readonly brandReference: string;
  readonly storeReference: string;
  readonly templateReference: string;
  readonly nextVersionNumber: number;
  readonly latestVersionReference: string | null;
}
export interface DigitalReceiptTemplateEditingReview {
  readonly profile: "DigitalReceiptTemplateEditingReviewV1";
  readonly submission: DigitalReceiptTemplateSubmission | null;
  readonly mutation: CommitPublishingMutationInput | null;
  readonly observedAt: string;
  readonly validUntil: string;
}
export interface DigitalReceiptTemplateDraftStoreOptions extends DigitalReceiptTemplateDraftActorScope {
  readonly transaction: DigitalReceiptTemplateDraftTransaction;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly registerBeforeCommit: (
    tx: DigitalReceiptTemplateDraftTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void> | void;
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: DigitalReceiptTemplateDraftTransaction,
      input: Readonly<
        DigitalReceiptTemplateDraftActorScope & {
          permission: "organization.manage" | "integration.manage";
          purposeCode: "RECEIPT_TEMPLATE_AUTHORING";
          mode: Mode;
          templateReference: string | null;
          targetVersionReference: string | null;
          requiredFields: typeof digitalReceiptTemplateDraftRequiredFields;
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
    nextReference(kind: "Template" | "Family" | "Version" | "Audit"): string;
  };
  readonly readEditingReview: (
    tx: DigitalReceiptTemplateDraftTransaction,
    input: Readonly<{
      templateReference: string;
      familyReference: string;
      observedAt: string;
      validUntil: string;
    }>,
  ) => Promise<DigitalReceiptTemplateEditingReview>;
  readonly readPublicationSequence: (
    tx: DigitalReceiptTemplateDraftTransaction,
    input: Readonly<{ templateReference: string; observedAt: string; validUntil: string }>,
  ) => Promise<DigitalReceiptTemplatePublicationSequence>;
  readonly readArtifact: (
    tx: DigitalReceiptTemplateDraftTransaction,
    input: Readonly<{
      artifactKind: DigitalReceiptTemplateArtifactKind;
      artifactReference: string;
      observedAt: string;
      validUntil: string;
    }>,
  ) => Promise<DigitalReceiptTemplateArtifactVersion | null>;
  readonly appendAudit: (
    tx: DigitalReceiptTemplateDraftTransaction,
    input: Readonly<
      DigitalReceiptTemplateDraftActorScope & {
        operationReference: string;
        auditReference: string;
        intentDigest: string;
        purposeCode: "RECEIPT_TEMPLATE_AUTHORING";
        mode: "Save" | "Abandon";
        occurredAt: string;
      }
    >,
  ) => Promise<void>;
}
const parseIntentDigest = (v: unknown): string => {
  if (typeof v !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(v))
    throw new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_UNAVAILABLE");
  return v;
};
const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const versionColumns = `template_id,family_id,version_id,revision::text revision,publication_version_number::text publication_version_number,operation_id,actor_id,previous_version_id,content_digest,snapshot_json,snapshot_digest,${utc("created_at")} created_at,${utc("updated_at")} updated_at`;
/** Immutable authoring revisions; presence does not prove Review, Publish or legal readiness. */
export function createPostgresDigitalReceiptTemplateDraftStore(
  options: DigitalReceiptTemplateDraftStoreOptions,
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
    auditPort = options.appendAudit,
    sequencePort = options.readPublicationSequence,
    artifactPort = options.readArtifact,
    editingPort = options.readEditingReview;
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
    mode: Mode | null = null,
    selectedTemplate: string | null = null,
    historicalReference: string | null = null;
  let rosterAfter: string | null = null;
  let heldRoster: readonly DigitalReceiptTemplateDraft[] | undefined;
  let heldCurrent: DigitalReceiptTemplateDraft | null | undefined,
    heldHistorical: DigitalReceiptTemplateDraft | null | undefined,
    heldWritten: DigitalReceiptTemplateDraft | undefined,
    originalReceipt: DigitalReceiptTemplateDraftReceipt | undefined;
  let heldSequence: DigitalReceiptTemplatePublicationSequence | undefined,
    heldArtifacts: readonly DigitalReceiptTemplateArtifactVersion[] | undefined;
  let heldEditing: DigitalReceiptTemplateEditingReview | undefined;
  let editingSubject: Readonly<{ templateReference: string; familyReference: string }> | undefined;
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
      sequencePort,
      artifactPort,
      editingPort,
    ].some((port) => typeof port !== "function") ||
    originalUntil <= origin ||
    Date.parse(originalUntil) - Date.parse(origin) > 5000
  )
    return fail();
  const check = () => {
    if (
      failed ||
      Object.entries(fixed).some(
        ([k, v]) => Object.getOwnPropertyDescriptor(options, k)?.value !== v,
      ) ||
      options.originalObservedAt !== origin ||
      options.originalValidUntil !== originalUntil ||
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
      options.readPublicationSequence !== sequencePort ||
      options.readArtifact !== artifactPort ||
      options.readEditingReview !== editingPort
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
          mode === "ReadRoster" || mode === "ReadCurrent" || mode === "ReadVersion"
            ? "organization.manage"
            : "integration.manage",
        purposeCode: "RECEIPT_TEMPLATE_AUTHORING",
        mode,
        templateReference: command ? command.templateReference : selectedTemplate,
        targetVersionReference: mode === "ReadVersion" ? historicalReference : null,
        requiredFields: digitalReceiptTemplateDraftRequiredFields,
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
  const root = async (template: string | null) => {
    if (template === null) return;
    await restore();
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `ReceiptTemplate:${fixed.brandReference}:${fixed.storeReference}:${template}`,
    ]);
  };
  const decodeVersion = (row: Record<string, unknown>): DigitalReceiptTemplateDraft => {
    if (Reflect.ownKeys(row).length !== 13) return fail();
    const snapshot = stored(() => parseDigitalReceiptTemplateDraft(row.snapshot_json));
    if (
      snapshot.tenantReference !== fixed.tenantReference ||
      snapshot.brandReference !== fixed.brandReference ||
      snapshot.storeReference !== fixed.storeReference ||
      row.template_id !== snapshot.content.templateReference ||
      row.family_id !== snapshot.familyReference ||
      row.version_id !== snapshot.content.versionReference ||
      row.revision !== String(snapshot.revision) ||
      row.publication_version_number !== String(snapshot.content.versionNumber) ||
      row.actor_id !== snapshot.authoredByReference ||
      row.previous_version_id !== snapshot.previousVersionReference ||
      row.content_digest !== snapshot.contentDigest ||
      row.created_at !== snapshot.createdAt ||
      row.updated_at !== snapshot.updatedAt ||
      snapshot.updatedAt > check() ||
      digest(snapshot.content) !== snapshot.contentDigest ||
      digest(snapshot) !== row.snapshot_digest
    )
      return fail();
    stored(() => parseDeviceReference(row.operation_id));
    return snapshot;
  };
  const readLatest = async (template: string | null) => {
    if (template === null) return null;
    await restore();
    const found = rows(
      await query(
        `SELECT ${versionColumns} FROM rms_device.digital_receipt_template_draft_revision WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND template_id=$4 ORDER BY revision DESC LIMIT 1`,
        [fixed.tenantReference, fixed.brandReference, fixed.storeReference, template],
      ),
    );
    if (!found[0]) return null;
    const snapshot = decodeVersion(found[0]);
    if (snapshot.content.templateReference !== template) return fail();
    return snapshot;
  };
  const readRosterHeads = async () => {
    await restore();
    const found = rows(
      await query(
        `SELECT ${versionColumns} FROM (SELECT DISTINCT ON (template_id) * FROM rms_device.digital_receipt_template_draft_revision WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 ORDER BY template_id,revision DESC) heads WHERE ($4::uuid IS NULL OR template_id>$4::uuid) ORDER BY template_id LIMIT 21`,
        [fixed.tenantReference, fixed.brandReference, fixed.storeReference, rosterAfter],
      ),
      21,
    );
    const result = Object.freeze(found.map(decodeVersion));
    let prior = rosterAfter;
    for (const entry of result) {
      if (prior !== null && entry.content.templateReference <= prior) return fail();
      prior = entry.content.templateReference;
    }
    return result;
  };
  const readExact = async (template: string, version: string) => {
    await restore();
    const found = rows(
      await query(
        `SELECT ${versionColumns} FROM rms_device.digital_receipt_template_draft_revision WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND template_id=$4 AND version_id=$5`,
        [fixed.tenantReference, fixed.brandReference, fixed.storeReference, template, version],
      ),
    );
    if (!found[0]) return null;
    const snapshot = decodeVersion(found[0]);
    if (
      snapshot.content.templateReference !== template ||
      snapshot.content.versionReference !== version
    )
      return fail();
    return snapshot;
  };
  const sequence = async (template: string) => {
    const raw = await sequencePort.call(
      options,
      tx,
      Object.freeze({ templateReference: template, observedAt: check(), validUntil: deadline }),
    );
    check();
    const keys = [
      "profile",
      "brandReference",
      "storeReference",
      "templateReference",
      "nextVersionNumber",
      "latestVersionReference",
    ];
    if (
      !raw ||
      Object.getPrototypeOf(raw) !== Object.prototype ||
      Reflect.ownKeys(raw).length !== keys.length ||
      keys.some((k) => {
        const d = Object.getOwnPropertyDescriptor(raw, k);
        return !d?.enumerable || !("value" in d);
      })
    )
      return fail();
    const p = Object.fromEntries(
      keys.map((k) => [k, Object.getOwnPropertyDescriptor(raw, k)?.value]),
    );
    if (
      p.profile !== "DigitalReceiptTemplatePublicationSequenceV1" ||
      p.brandReference !== fixed.brandReference ||
      p.storeReference !== fixed.storeReference ||
      p.templateReference !== template ||
      typeof p.nextVersionNumber !== "number" ||
      !Number.isSafeInteger(p.nextVersionNumber) ||
      p.nextVersionNumber < 1 ||
      p.nextVersionNumber > 100 ||
      (p.nextVersionNumber === 1) !== (p.latestVersionReference === null)
    )
      return fail();
    const result: DigitalReceiptTemplatePublicationSequence = Object.freeze({
      profile: "DigitalReceiptTemplatePublicationSequenceV1",
      brandReference: fixed.brandReference,
      storeReference: fixed.storeReference,
      templateReference: template,
      nextVersionNumber: p.nextVersionNumber,
      latestVersionReference:
        p.latestVersionReference === null
          ? null
          : stored(() => parseDeviceReference(p.latestVersionReference)),
    });
    await restore();
    return result;
  };
  const artifacts = async (snapshot: DigitalReceiptTemplateDraft) => {
    const result: DigitalReceiptTemplateArtifactVersion[] = [];
    for (const [kind, reference] of [
      ["Layout", snapshot.content.layoutDefinitionReference],
      ["Compliance", snapshot.content.complianceRuleReference],
    ] as const) {
      const value = await artifactPort.call(
        options,
        tx,
        Object.freeze({
          artifactKind: kind,
          artifactReference: reference,
          observedAt: check(),
          validUntil: deadline,
        }),
      );
      check();
      if (value === null) return fail("RECEIPT_TEMPLATE_CONFLICT");
      const artifact = stored(() => parseDigitalReceiptTemplateArtifactVersion(value));
      if (
        artifact.artifactKind !== kind ||
        artifact.artifactReference !== reference ||
        artifact.tenantReference !== fixed.tenantReference ||
        artifact.brandReference !== fixed.brandReference ||
        artifact.storeReference !== fixed.storeReference ||
        artifact.updatedAt > check()
      )
        return fail();
      result.push(artifact);
      await restore();
    }
    return Object.freeze(result);
  };
  const fieldsFor = (snapshot: DigitalReceiptTemplateDraft) => ({
    locale: snapshot.content.locale,
    layoutDefinitionReference: snapshot.content.layoutDefinitionReference,
    complianceRuleReference: snapshot.content.complianceRuleReference,
    activation: snapshot.content.activation,
    effectiveUntil: snapshot.content.effectiveUntil,
  });
  const lookup = async (original: Original): Promise<DigitalReceiptTemplateDraftReceipt | null> => {
    await restore();
    const found = rows(
      await query(
        `SELECT operation_id,tenant_id,brand_id,store_id,actor_id,template_id,intent_digest,expected_version_id,expected_revision::text expected_revision,outcome,result_version_id,result_revision::text result_revision,snapshot_digest,audit_reference,${utc("occurred_at")} occurred_at FROM rms_device.digital_receipt_template_draft_operation WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4`,
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
    if (Reflect.ownKeys(row).length !== 15 || row.operation_id !== original.operationReference)
      return fail();
    if (
      row.tenant_id !== fixed.tenantReference ||
      row.brand_id !== fixed.brandReference ||
      row.store_id !== fixed.storeReference ||
      row.actor_id !== fixed.actorReference
    )
      return fail("RECEIPT_TEMPLATE_PERMISSION_DENIED");
    const expectedRevision = Number(row.expected_revision);
    if (
      !Number.isSafeInteger(expectedRevision) ||
      String(expectedRevision) !== row.expected_revision
    )
      return fail();
    let snapshot: DigitalReceiptTemplateDraft | null = null;
    if (row.outcome === "Committed") {
      const versions = rows(
        await query(
          `SELECT ${versionColumns} FROM rms_device.digital_receipt_template_draft_revision WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND version_id=$4 AND revision=$5 AND operation_id=$6`,
          [
            fixed.tenantReference,
            fixed.brandReference,
            fixed.storeReference,
            row.result_version_id,
            row.result_revision,
            row.operation_id,
          ],
        ),
      );
      if (!versions[0] || versions[0].operation_id !== row.operation_id) return fail();
      snapshot = decodeVersion(versions[0]);
      if (
        snapshot.content.versionReference !== row.result_version_id ||
        String(snapshot.revision) !== row.result_revision ||
        digest(snapshot) !== row.snapshot_digest
      )
        return fail();
    } else if (
      row.outcome !== "Abandoned" ||
      row.result_version_id !== null ||
      row.result_revision !== null ||
      row.snapshot_digest !== null
    )
      return fail();
    const receipt = stored(() =>
      parseDigitalReceiptTemplateDraftReceipt({
        profile: "DigitalReceiptTemplateDraftReceiptV1",
        ...fixed,
        operationReference: row.operation_id,
        templateReference: row.template_id,
        expectedVersionReference: row.expected_version_id,
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
        parseDigitalReceiptTemplateDraftSave({
          profile: "DigitalReceiptTemplateDraftSaveV1",
          ...fixed,
          operationReference: receipt.operationReference,
          templateReference: receipt.templateReference,
          expectedVersionReference: receipt.expectedVersionReference,
          expectedRevision: receipt.expectedRevision,
          purposeCode: "RECEIPT_TEMPLATE_AUTHORING",
          fields: fieldsFor(persisted),
        }),
      );
      if (digest(originalSave) !== receipt.intentDigest) return fail();
    }
    if (
      receipt.intentDigest !==
        (original.profile === "DigitalReceiptTemplateDraftSaveV1"
          ? digest(original)
          : original.intentDigest) ||
      receipt.templateReference !== original.templateReference ||
      receipt.expectedVersionReference !== original.expectedVersionReference ||
      receipt.expectedRevision !== original.expectedRevision
    )
      return fail("RECEIPT_TEMPLATE_CONFLICT");
    return receipt;
  };
  const append = async (
    original: Original,
    snapshot: DigitalReceiptTemplateDraft | null,
    at: string,
  ) => {
    const intentDigest =
        original.profile === "DigitalReceiptTemplateDraftSaveV1"
          ? digest(original)
          : original.intentDigest,
      auditReference = parseDeviceReference(nextPort.call(referenceOwner, "Audit"));
    check();
    const returned = await auditPort.call(
      options,
      tx,
      Object.freeze({
        ...fixed,
        operationReference: original.operationReference,
        auditReference,
        intentDigest,
        purposeCode: "RECEIPT_TEMPLATE_AUTHORING",
        mode: snapshot ? "Save" : "Abandon",
        occurredAt: at,
      }),
    );
    if (returned !== undefined) return fail();
    check();
    await restore();
    await insert(
      "INSERT INTO rms_device.digital_receipt_template_draft_operation(operation_id,tenant_id,brand_id,store_id,actor_id,template_id,intent_digest,expected_version_id,expected_revision,outcome,result_version_id,result_revision,snapshot_digest,audit_reference,occurred_at,data_classification) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'Internal')",
      [
        original.operationReference,
        fixed.tenantReference,
        fixed.brandReference,
        fixed.storeReference,
        fixed.actorReference,
        original.templateReference,
        intentDigest,
        original.expectedVersionReference,
        original.expectedRevision,
        snapshot ? "Committed" : "Abandoned",
        snapshot?.content.versionReference ?? null,
        snapshot?.revision ?? null,
        snapshot ? digest(snapshot) : null,
        auditReference,
        at,
      ],
    );
    wroteTerminal = true;
    return parseDigitalReceiptTemplateDraftReceipt({
      profile: "DigitalReceiptTemplateDraftReceiptV1",
      ...fixed,
      operationReference: original.operationReference,
      templateReference: original.templateReference,
      expectedVersionReference: original.expectedVersionReference,
      expectedRevision: original.expectedRevision,
      intentDigest,
      outcome: snapshot ? "Committed" : "Abandoned",
      snapshot,
      auditReference,
      occurredAt: at,
    });
  };
  const editingIdentity = (packet: DigitalReceiptTemplateEditingReview) => ({
    profile: packet.profile,
    submission: packet.submission,
    mutation: packet.mutation,
  });
  const editingReview = async (
    subject: Readonly<{ templateReference: string; familyReference: string }>,
  ) => {
    check();
    const value = await editingPort.call(
      options,
      tx,
      Object.freeze({ ...subject, observedAt: origin, validUntil: deadline }),
    );
    check();
    const keys = ["profile", "submission", "mutation", "observedAt", "validUntil"];
    if (
      !value ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== keys.length
    )
      return fail();
    const raw: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
      raw[key] = descriptor.value;
    }
    const observedAt = stored(() => parseDeviceInstant(raw.observedAt)),
      validUntil = stored(() => parseDeviceInstant(raw.validUntil));
    if (
      raw.profile !== "DigitalReceiptTemplateEditingReviewV1" ||
      observedAt < origin ||
      observedAt > check() ||
      validUntil > deadline ||
      validUntil <= latest
    )
      return fail();
    const submission =
      raw.submission === null
        ? null
        : stored(() => parseDigitalReceiptTemplateSubmission(raw.submission));
    const mutation =
      raw.mutation === null ? null : stored(() => parseRecordedPublishingMutation(raw.mutation));
    if ((submission === null) !== (mutation === null)) return fail();
    if (submission && mutation) {
      const next = mutation.next,
        audit = mutation.audit;
      const states = ["InReview", "Approved", "Published", "Archived"];
      if (
        submission.tenantReference !== fixed.tenantReference ||
        submission.brandReference !== fixed.brandReference ||
        submission.storeReference !== fixed.storeReference ||
        submission.templateReference !== subject.templateReference ||
        submission.familyReference !== subject.familyReference ||
        submission.submittedAt > observedAt ||
        String(next.lifecycleId) !== submission.reviewLifecycleReference ||
        String(next.familyReference) !== submission.familyReference ||
        String(next.snapshotReference) !== submission.versionReference ||
        next.snapshotDigest !== submission.contentDigest ||
        next.version < submission.reviewVersion ||
        String(next.validationEvidenceReference) !== submission.validationEvidenceReference ||
        next.configurationType !== "RECEIPT_TEMPLATE" ||
        next.purposeCode !== "RECEIPT_ISSUANCE" ||
        next.scope.kind !== "Store" ||
        String(next.scope.brandReference) !== fixed.brandReference ||
        String(next.scope.storeReference) !== fixed.storeReference ||
        !states.includes(next.state) ||
        next.changedAt < submission.submittedAt ||
        next.changedAt > observedAt ||
        String(audit.brandId) !== fixed.brandReference ||
        String(audit.storeId) !== fixed.storeReference ||
        audit.actor.type !== "User" ||
        audit.targetType !== "PublishingLifecycle" ||
        String(audit.targetId) !== submission.reviewLifecycleReference ||
        audit.occurredAt !== next.changedAt ||
        audit.occurredAt > observedAt ||
        audit.actionCode !==
          {
            SubmitReview: "PUBLISHING_REVIEW_SUBMITTED",
            Approve: "PUBLISHING_REVIEW_APPROVED",
            Publish: "PUBLISHING_RELEASE_PUBLISHED",
            Rollback: "PUBLISHING_RELEASE_ROLLED_BACK",
            Archive: "PUBLISHING_RELEASE_ARCHIVED",
            CreateDraft: "PUBLISHING_DRAFT_CREATED",
          }[mutation.operation] ||
        !evaluatePublishingTransition({
          operation: mutation.operation,
          expectedVersion: mutation.expectedVersion,
          current: mutation.current,
          next,
        }).allowed
      )
        return fail();
      if (
        next.state === "InReview" &&
        (!mutation.validationEvidence ||
          mutation.validationEvidence.result !== "Pass" ||
          String(mutation.validationEvidence.snapshotReference) !== submission.versionReference ||
          mutation.validationEvidence.snapshotDigest !== submission.contentDigest ||
          mutation.validationEvidence.scope.kind !== "Store" ||
          String(mutation.validationEvidence.scope.brandReference) !== fixed.brandReference ||
          String(mutation.validationEvidence.scope.storeReference) !== fixed.storeReference ||
          mutation.operation !== "SubmitReview" ||
          String(mutation.idempotencyKey) !== submission.operationReference ||
          next.version !== submission.reviewVersion ||
          audit.actor.reference !== submission.submittedByReference ||
          String(audit.auditId) !== submission.auditReference ||
          audit.occurredAt !== submission.submittedAt ||
          mutation.validationEvidence?.evidenceReference !==
            submission.validationEvidenceReference ||
          mutation.validationEvidence.checkedAt !== submission.checkedAt ||
          mutation.validationEvidence.validUntil !== submission.validationValidUntil)
      )
        return fail();
      if (
        (next.state === "Approved" && mutation.operation !== "Approve") ||
        (next.state === "Published" &&
          mutation.operation !== "Publish" &&
          mutation.operation !== "Rollback") ||
        (next.state === "Archived" && mutation.operation !== "Archive")
      )
        return fail();
    }
    if (validUntil < deadline) deadline = validUntil;
    check();
    await restore();
    return Object.freeze({
      profile: "DigitalReceiptTemplateEditingReviewV1" as const,
      submission,
      mutation,
      observedAt,
      validUntil,
    });
  };
  const admit = async (selected: Mode, original: Original | null) => {
    if (active || phase !== "Work" || (mode !== null && mode !== selected)) return fail();
    active = true;
    mode = selected;
    if (original) {
      if (
        Object.entries(fixed).some(
          ([k, v]) => Object.getOwnPropertyDescriptor(original, k)?.value !== v,
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
            await root(selectedTemplate);
            if (heldRoster !== undefined && !same(await readRosterHeads(), heldRoster))
              return fail("RECEIPT_TEMPLATE_CONFLICT");
            if (heldCurrent !== undefined && !same(await readLatest(selectedTemplate), heldCurrent))
              return fail("RECEIPT_TEMPLATE_CONFLICT");
            if (
              heldHistorical !== undefined &&
              (selectedTemplate === null ||
                historicalReference === null ||
                !same(await readExact(selectedTemplate, historicalReference), heldHistorical))
            )
              return fail();
            if (heldEditing && editingSubject) {
              const currentReview = await editingReview(editingSubject);
              if (!same(editingIdentity(currentReview), editingIdentity(heldEditing)))
                return fail("RECEIPT_TEMPLATE_CONFLICT");
            }
            if (heldWritten) {
              if (!same(await readLatest(heldWritten.content.templateReference), heldWritten))
                return fail("RECEIPT_TEMPLATE_CONFLICT");
              if (
                !same(await sequence(heldWritten.content.templateReference), heldSequence) ||
                !same(await artifacts(heldWritten), heldArtifacts)
              )
                return fail("RECEIPT_TEMPLATE_CONFLICT");
            }
            if (originalReceipt && command && !same(await lookup(command), originalReceipt))
              return fail();
            await hold();
            await restore();
            if (wroteTerminal)
              await query(
                "SET CONSTRAINTS rms_device.digital_receipt_template_draft_revision_coherence,rms_device.digital_receipt_template_draft_operation_coherence IMMEDIATE",
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
        "ReceiptTemplateDraftOperation:" + original.operationReference,
      ]);
    else await root(selectedTemplate);
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
  const inputReference = (value: unknown) => {
    try {
      return parseDeviceReference(value);
    } catch {
      return fail("RECEIPT_TEMPLATE_INPUT_INVALID");
    }
  };
  const request = (value: unknown, keys: readonly string[]) => {
    if (
      !value ||
      typeof value !== "object" ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== keys.length
    )
      return fail("RECEIPT_TEMPLATE_INPUT_INVALID");
    const r: Record<string, unknown> = {};
    for (const key of keys) {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d?.enumerable || !("value" in d)) return fail("RECEIPT_TEMPLATE_INPUT_INVALID");
      r[key] = d.value;
    }
    return r;
  };
  return Object.freeze({
    readRoster: (value: unknown) =>
      protect(async () => {
        const r = request(value, ["afterTemplate"]),
          after = r.afterTemplate === null ? null : inputReference(r.afterTemplate);
        if (mode !== null && (mode !== "ReadRoster" || rosterAfter !== after)) return fail();
        rosterAfter = after;
        await admit("ReadRoster", null);
        const heads = await readRosterHeads();
        for (const entry of heads.slice(0, 20)) await root(entry.content.templateReference);
        const fresh = await readRosterHeads();
        if (!same(heads, fresh)) return fail("RECEIPT_TEMPLATE_CONFLICT");
        heldRoster = fresh;
        await hold();
        const entries = fresh.slice(0, 20),
          last = entries.at(-1);
        return parseDigitalReceiptTemplateDraftRoster({
          profile: "DigitalReceiptTemplateDraftRosterV1",
          ...fixed,
          afterTemplate: after,
          entries,
          nextAfter: fresh.length > 20 && last ? last.content.templateReference : null,
          observedAt: check(),
          validUntil: deadline,
          sourceQualification: "NotEvaluated",
        });
      }),
    readCurrent: (value: unknown) =>
      protect(async () => {
        const r = request(value, ["templateReference"]),
          template = r.templateReference === null ? null : inputReference(r.templateReference);
        if (mode !== null && (mode !== "ReadCurrent" || selectedTemplate !== template))
          return fail();
        selectedTemplate = template;
        await admit("ReadCurrent", null);
        heldCurrent = await readLatest(template);
        await hold();
        return parseDigitalReceiptTemplateDraftCurrent({
          profile: "DigitalReceiptTemplateDraftCurrentV1",
          ...fixed,
          templateReference: template,
          snapshot: heldCurrent,
          observedAt: check(),
          validUntil: deadline,
          sourceQualification: "NotEvaluated",
        });
      }),
    readVersion: (value: unknown) =>
      protect(async () => {
        const r = request(value, ["templateReference", "versionReference"]),
          template = inputReference(r.templateReference),
          version = inputReference(r.versionReference);
        if (
          mode !== null &&
          (mode !== "ReadVersion" ||
            selectedTemplate !== template ||
            historicalReference !== version)
        )
          return fail();
        selectedTemplate = template;
        historicalReference = version;
        await admit("ReadVersion", null);
        heldHistorical = await readExact(template, version);
        await hold();
        return heldHistorical;
      }),
    save: (value: unknown) =>
      protect(async () => {
        const original = parseDigitalReceiptTemplateDraftSave(value);
        await admit("Save", original);
        const old = await lookup(original);
        if (old) {
          originalReceipt = old;
          await hold();
          return old;
        }
        const template =
          original.templateReference ??
          parseDeviceReference(nextPort.call(referenceOwner, "Template"));
        check();
        selectedTemplate = template;
        await root(template);
        const prior = await readLatest(template);
        if (
          (prior?.revision ?? 0) !== original.expectedRevision ||
          (prior?.content.versionReference ?? null) !== original.expectedVersionReference
        )
          return fail("RECEIPT_TEMPLATE_CONFLICT");
        if (prior) {
          editingSubject = Object.freeze({
            templateReference: template,
            familyReference: prior.familyReference,
          });
          heldEditing = await editingReview(editingSubject);
          if (
            heldEditing.submission &&
            heldEditing.mutation &&
            ["InReview", "Approved"].includes(heldEditing.mutation.next.state) &&
            heldEditing.submission.validationValidUntil > check()
          )
            return fail("RECEIPT_TEMPLATE_CONFLICT");
        }
        const publicationSequence = await sequence(template),
          version = parseDeviceReference(nextPort.call(referenceOwner, "Version")),
          family =
            prior?.familyReference ?? parseDeviceReference(nextPort.call(referenceOwner, "Family"));
        check();
        if (
          version === prior?.content.versionReference ||
          version === template ||
          family === template ||
          family === version
        )
          return fail();
        const content = createDigitalReceiptTemplateDraftContent({
          tenantReference: fixed.tenantReference,
          brandReference: fixed.brandReference,
          storeReference: fixed.storeReference,
          templateReference: template,
          versionReference: version,
          versionNumber: publicationSequence.nextVersionNumber,
          fields: original.fields,
        });
        const at = check(),
          snapshot = parseDigitalReceiptTemplateDraft({
            profile: "DigitalReceiptTemplateDraftV2",
            tenantReference: fixed.tenantReference,
            brandReference: fixed.brandReference,
            storeReference: fixed.storeReference,
            familyReference: family,
            revision: original.expectedRevision + 1,
            authoredByReference: fixed.actorReference,
            previousVersionReference: prior?.content.versionReference ?? null,
            content,
            contentDigest: digest(content),
            createdAt: prior?.createdAt ?? at,
            updatedAt: at,
            dataClassification: "Internal",
          });
        heldSequence = publicationSequence;
        heldArtifacts = await artifacts(snapshot);
        await hold();
        await restore();
        await insert(
          "INSERT INTO rms_device.digital_receipt_template_draft_revision(tenant_id,brand_id,store_id,template_id,family_id,version_id,revision,publication_version_number,operation_id,actor_id,previous_version_id,content_digest,snapshot_json,snapshot_digest,created_at,updated_at,data_classification) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,'Internal')",
          [
            fixed.tenantReference,
            fixed.brandReference,
            fixed.storeReference,
            template,
            family,
            version,
            snapshot.revision,
            content.versionNumber,
            original.operationReference,
            fixed.actorReference,
            snapshot.previousVersionReference,
            snapshot.contentDigest,
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
        const original = parseDigitalReceiptTemplateDraftResolve(value);
        await admit("Resolve", original);
        const old = await lookup(original);
        if (old) {
          originalReceipt = old;
          await hold();
          return old;
        }
        selectedTemplate = original.templateReference;
        await root(selectedTemplate);
        const receipt = await append(original, null, check());
        originalReceipt = receipt;
        await hold();
        return receipt;
      }),
    assertFinalized(actual: DigitalReceiptTemplateDraftTransaction): string {
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
