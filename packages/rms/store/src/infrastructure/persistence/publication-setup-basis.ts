import { parsePlatformTenantReference } from "@bop/tenant";
import type { StoreConfigurationVersion } from "../../contracts/store-configuration-administration.js";
import {
  parseStoreSetupDraft,
  storeSetupDraftContentFields,
} from "../../contracts/store-setup-draft.js";
import {
  parseStoreSetupSaveCommand,
  parseStoreSetupIntentDigest,
} from "../../contracts/store-setup-operation.js";

export interface StorePublicationSetupSnapshotReferences {
  canonicalize(value: unknown): string;
  hashIntent(canonical: string): string;
}
interface Transaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
/** Owning immutable provenance only; current permission, Publishing and Live Gate
 * remain the caller's held authority. No current classification qualification. */
export function createStorePublicationSetupBasisVerifier(options: {
  readonly tenantReference?: string;
  readonly setupSnapshotReferences?: StorePublicationSetupSnapshotReferences;
}) {
  const tenantInput = options.tenantReference;
  const references = options.setupSnapshotReferences;
  const canonicalize = references?.canonicalize;
  const hashIntent = references?.hashIntent;
  const fail = (): never => {
    throw new Error("STORE_PUBLICATION_SETUP_BASIS_UNAVAILABLE");
  };
  const check = () => {
    if (
      options.tenantReference !== tenantInput ||
      options.setupSnapshotReferences !== references ||
      references?.canonicalize !== canonicalize ||
      references?.hashIntent !== hashIntent
    )
      return fail();
  };
  return async (tx: Transaction, configuration: StoreConfigurationVersion, at: string) => {
    check();
    const basis = configuration.setupBasis;
    if (basis === undefined) return;
    if (!tenantInput || !references || !canonicalize || !hashIntent) return fail();
    const tenant = parsePlatformTenantReference(tenantInput);
    if (String(basis.tenantReference) !== String(tenant)) return fail();
    const query = tx.query;
    const digest = (value: unknown) => {
      check();
      const text = canonicalize.call(references, value);
      if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 2097152) return fail();
      const result = parseStoreSetupIntentDigest(hashIntent.call(references, text));
      check();
      return result;
    };
    await query.call(
      tx,
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
      [tenant, configuration.brandReference, configuration.storeReference],
    );
    const result = await query.call(
      tx,
      `SELECT r.snapshot_json,r.snapshot_digest,o.operation_id,o.actor_id,o.expected_setup_id,o.expected_revision::text expected_revision,o.intent_digest
      FROM rms_store.store_setup_draft_revision r JOIN rms_store.store_setup_draft_operation o
      ON o.tenant_id=r.tenant_id AND o.brand_id=r.brand_id AND o.store_id=r.store_id
      AND o.operation_id=r.operation_id AND o.actor_id=r.actor_id AND o.outcome='Committed'
      AND o.result_setup_id=r.setup_draft_id AND o.result_revision=r.revision
      AND o.snapshot_digest=r.snapshot_digest AND o.occurred_at=r.updated_at
      WHERE r.tenant_id=$1 AND r.brand_id=$2 AND r.store_id=$3 AND r.setup_draft_id=$4
      AND r.revision=$5 AND r.snapshot_digest=$6`,
      [
        tenant,
        configuration.brandReference,
        configuration.storeReference,
        basis.setupDraftReference,
        basis.sourceRevision,
        basis.sourceSnapshotDigest,
      ],
    );
    check();
    if (tx.query !== query || !result || typeof result !== "object") return fail();
    const descriptor = Object.getOwnPropertyDescriptor(result, "rows");
    if (
      !descriptor ||
      !("value" in descriptor) ||
      !Array.isArray(descriptor.value) ||
      descriptor.value.length !== 1
    )
      return fail();
    const member = Object.getOwnPropertyDescriptor(descriptor.value, "0");
    if (!member?.enumerable || !("value" in member)) return fail();
    const row = member.value;
    if (!row || typeof row !== "object" || Object.getPrototypeOf(row) !== Object.prototype)
      return fail();
    const values: Record<string, unknown> = {};
    for (const field of [
      "snapshot_json",
      "snapshot_digest",
      "operation_id",
      "actor_id",
      "expected_setup_id",
      "expected_revision",
      "intent_digest",
    ]) {
      const d = Object.getOwnPropertyDescriptor(row, field);
      if (!d?.enumerable || !("value" in d)) return fail();
      values[field] = d.value;
    }
    const snapshot = parseStoreSetupDraft(values.snapshot_json);
    if (
      snapshot.profile !== "StoreSetupDraftV2" ||
      String(snapshot.tenantReference) !== String(tenant) ||
      snapshot.brandReference !== configuration.brandReference ||
      snapshot.storeReference !== configuration.storeReference ||
      snapshot.setupDraftReference !== basis.setupDraftReference ||
      snapshot.revision !== basis.sourceRevision ||
      digest(snapshot) !== basis.sourceSnapshotDigest ||
      values.snapshot_digest !== basis.sourceSnapshotDigest ||
      snapshot.defaultLocale !== configuration.defaultLocale ||
      snapshot.currencyCode !== configuration.currencyCode ||
      snapshot.baseConfigurationReference !== configuration.supersedesConfigurationReference ||
      snapshot.updatedAt > at ||
      snapshot.updatedAt > configuration.createdAt ||
      snapshot.content.feeContexts?.state !== "Configured" ||
      JSON.stringify(snapshot.content.feeContexts.value) !== JSON.stringify(basis.feeContexts)
    )
      return fail();
    for (const field of storeSetupDraftContentFields) {
      const part = snapshot.content[field];
      if (
        part.state !== "Configured" ||
        JSON.stringify(part.value) !== JSON.stringify(configuration[field])
      )
        return fail();
    }
    const expected = Number(values.expected_revision);
    if (
      !Number.isSafeInteger(expected) ||
      String(expected) !== values.expected_revision ||
      expected + 1 !== snapshot.revision ||
      values.actor_id !== snapshot.authoredByReference
    )
      return fail();
    const original = parseStoreSetupSaveCommand({
      profile: "StoreSetupSaveV2",
      tenantReference: tenant,
      brandReference: configuration.brandReference,
      storeReference: configuration.storeReference,
      actorReference: snapshot.authoredByReference,
      operationReference: values.operation_id,
      expectedSetupReference: values.expected_setup_id,
      expectedRevision: expected,
      purposeCode: "STORE_SETUP_DRAFT",
      content: snapshot.content,
    });
    if (digest(original) !== values.intent_digest) return fail();
    check();
  };
}
