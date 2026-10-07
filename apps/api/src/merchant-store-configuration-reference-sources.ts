import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  parseCanonicalInstant,
  createPostgresTenantStoreBrandConfigurationContentSource,
  parseTenantStoreBrandConfigurationContentRequest,
  tenantBrandConfigurationRequiredFields,
  type TenantStoreBrandConfigurationContentRequest,
} from "@bop/tenant";
import {
  createPostgresStoreSetupReferenceStore,
  parseStoreAdministrationReference,
  StoreConfigurationOriginalError,
  storeSetupReferenceOperationRequiredFields,
} from "@rms/store";
import {
  createPostgresStorePaymentConfigurationStore,
  storePaymentConfigurationRequiredFields,
} from "@rms/payment";
import {
  createPostgresDigitalReceiptTemplateStore,
  createPostgresDigitalReceiptTemplateSubmissionStore,
  createPostgresReceiptTemplateContentPublicationProof,
  digitalReceiptTemplateSubmissionRequiredFields,
  type DigitalReceiptTemplateAuthoredContent,
  type DigitalReceiptTemplateVersion,
} from "@rms/printing-device";
import {
  createPostgresPublishingMutationStore,
  createPublishingScope,
  parsePublishingReference,
} from "@bop/publishing";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import {
  createCurrentStoreBrandConfigurationContentSource,
  type CurrentBrandConfigurationContent,
} from "./current-brand-configuration-content.js";
import type { MerchantStoreConfigurationOrdinarySourceHost } from "./merchant-store-configuration-ordinary.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

type Scope = Awaited<ReturnType<ReturnType<typeof createMerchantStoreScope>>>;
type Transaction = Parameters<
  MerchantStoreConfigurationOrdinarySourceHost["registerBeforeCommit"]
>[0];
export interface MerchantStoreConfigurationReferenceSourcesOptions {
  readonly persistence: PersistentMerchantBffOptions;
  readonly sessionCookie: unknown;
  readonly transaction: Transaction;
  readonly scope: Scope;
  readonly sourceHost: MerchantStoreConfigurationOrdinarySourceHost;
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
}
const references = Object.freeze({
  canonicalize: canonicalizeRfc8785,
  hashIntent: (text: string) => "sha256:" + sha256Hex(text),
});
/** Read-only owner composition. Recorded references do not establish external
 * address verification, Provider readiness, professional Tax or Live Gate approval.
 * Required-field inventories bind owner admission; IAM currently authorizes the
 * complete owning read through organization.manage, without a field-mask claim. */
export function createMerchantStoreConfigurationReferenceSources(
  options: MerchantStoreConfigurationReferenceSourcesOptions,
) {
  readClosedRecord(options, [
    "persistence",
    "sessionCookie",
    "transaction",
    "scope",
    "sourceHost",
    "originalObservedAt",
    "originalValidUntil",
  ]);
  const persistence = options.persistence,
    tx = options.transaction,
    query = tx.query,
    selected = options.scope,
    host = options.sourceHost,
    now = persistence.now,
    register = host.registerBeforeCommit,
    postCommit = host.registerAfterCommit,
    resolve = createMerchantStoreScope(persistence),
    cookie = options.sessionCookie,
    store = selected.store,
    context = selected.context,
    brand = context.brand,
    session = selected.sessionReference,
    allowed = selected.allowed,
    lease = selected.authorizationValidUntil;
  const identityOwner = persistence.identity,
    hasher = identityOwner.hasher,
    currentActor = persistence.currentActor,
    association = persistence.validateAssociation;
  const fixed = Object.freeze({
    tenantReference: parseStoreAdministrationReference(selected.selected.tenantReference),
    brandReference: parseStoreAdministrationReference(brand.brandReference),
    storeReference: parseStoreAdministrationReference(store.storeReference),
    actorReference: parseStoreAdministrationReference(selected.actorReference),
  });
  const origin = parseCanonicalInstant(options.originalObservedAt),
    originalUntil = parseCanonicalInstant(options.originalValidUntil),
    locale = store.locale,
    currency = store.currencyCode;
  let deadline: string = originalUntil,
    last: string = origin,
    failed = false,
    active = false,
    registered = false,
    phase: "Work" | "Checks" | "Final" = "Work",
    guards = 0,
    finals = 0;
  const fail: (code?: StoreConfigurationOriginalError["code"]) => never = (
    code = "STORE_CONFIGURATION_ORIGINAL_DEPENDENCY_UNAVAILABLE",
  ) => {
    failed = true;
    throw new StoreConfigurationOriginalError(code);
  };
  if (Date.parse(originalUntil) - Date.parse(origin) > 5000 || originalUntil <= origin) fail();
  const capturedOptions = Object.getOwnPropertyDescriptors(options);
  const identity = () => {
    if (
      Reflect.ownKeys(options).length !== Reflect.ownKeys(capturedOptions).length ||
      Object.entries(capturedOptions).some(([key, old]) => {
        const d = Object.getOwnPropertyDescriptor(options, key);
        return !d?.enumerable || !("value" in d) || d.value !== old.value;
      })
    )
      fail();
    if (
      failed ||
      options.persistence !== persistence ||
      options.transaction !== tx ||
      tx.query !== query ||
      persistence.now !== now ||
      persistence.identity !== identityOwner ||
      identityOwner.hasher !== hasher ||
      persistence.currentActor !== currentActor ||
      persistence.validateAssociation !== association ||
      options.scope !== selected ||
      options.sourceHost !== host ||
      host.registerBeforeCommit !== register ||
      host.registerAfterCommit !== postCommit ||
      options.sessionCookie !== cookie ||
      options.originalObservedAt !== origin ||
      options.originalValidUntil !== originalUntil ||
      selected.allowed !== allowed ||
      selected.authorizationValidUntil !== lease
    )
      fail();
    if (
      selected.store !== store ||
      selected.context !== context ||
      context.brand !== brand ||
      selected.sessionReference !== session ||
      store.locale !== locale ||
      store.currencyCode !== currency ||
      String(selected.selected.tenantReference) !== fixed.tenantReference ||
      String(brand.brandReference) !== fixed.brandReference ||
      String(store.storeReference) !== fixed.storeReference ||
      String(selected.actorReference) !== fixed.actorReference
    )
      fail("STORE_CONFIGURATION_ORIGINAL_PERMISSION_DENIED");
  };
  const check = () => {
    identity();
    const at = parseCanonicalInstant(now.call(persistence));
    identity();
    if (at < last || at >= deadline) fail();
    last = at;
    return at;
  };
  const retain = (until: string | null) => {
    if (until === null) fail();
    const parsed = parseCanonicalInstant(until);
    if (parsed < deadline) deadline = parsed;
    check();
  };
  const fresh = async () => {
    check();
    const current = await resolve(tx, cookie, "organization.manage", session);
    identity();
    const currentStore = current.store,
      currentContext = current.context,
      currentSelected = current.selected,
      actionPort = current.authorizeAction,
      currentLease = current.authorizationValidUntil;
    const currentIdentity = () => {
      identity();
      if (
        current.store !== currentStore ||
        current.context !== currentContext ||
        current.selected !== currentSelected ||
        current.authorizeAction !== actionPort ||
        current.authorizationValidUntil !== currentLease
      )
        fail();
      if (
        current.sessionReference !== session ||
        String(currentSelected.tenantReference) !== fixed.tenantReference ||
        String(currentContext.brand.brandReference) !== fixed.brandReference ||
        String(currentStore.storeReference) !== fixed.storeReference ||
        String(current.actorReference) !== fixed.actorReference ||
        currentStore.locale !== locale ||
        currentStore.currencyCode !== currency
      )
        fail("STORE_CONFIGURATION_ORIGINAL_PERMISSION_DENIED");
    };
    currentIdentity();
    const decision = await actionPort.call(current, "organization.manage");
    currentIdentity();
    if (
      !decision ||
      !Object.isFrozen(decision) ||
      decision.effect !== "Allow" ||
      decision.action !== "organization.manage" ||
      decision.scopeKind !== "Store"
    )
      fail("STORE_CONFIGURATION_ORIGINAL_PERMISSION_DENIED");
    retain(currentLease.call(current));
    currentIdentity();
    retain(lease.call(selected));
    currentIdentity();
    check();
  };
  const brandReads = new Map<
    string,
    {
      read(): Promise<CurrentBrandConfigurationContent>;
      baseline: CurrentBrandConfigurationContent;
    }
  >();
  const children: { assertFinalized(actual: Transaction): string }[] = [];
  const receiptReaders = new Map<
    string,
    {
      read(): Promise<DigitalReceiptTemplateVersion>;
      baseline: DigitalReceiptTemplateVersion;
    }
  >();
  const initialize = async () => {
    if (registered) return;
    registered = true;
    await register.call(
      host,
      tx,
      async () => {
        if (++guards !== 1 || active || phase !== "Work") fail();
        phase = "Checks";
        await fresh();
        for (const reader of brandReads.values()) {
          const value = await reader.read();
          if (canonicalizeRfc8785(value) !== canonicalizeRfc8785(reader.baseline))
            fail("STORE_CONFIGURATION_ORIGINAL_VERSION_CONFLICT");
        }
        for (const reader of receiptReaders.values()) {
          const value = await reader.read();
          if (canonicalizeRfc8785(value) !== canonicalizeRfc8785(reader.baseline))
            fail("STORE_CONFIGURATION_ORIGINAL_VERSION_CONFLICT");
        }
        await fresh();
      },
      () => {
        check();
        if (++finals !== 1 || guards !== 1 || phase !== "Checks" || active) fail();
        phase = "Final";
      },
    );
    identity();
    const returned = postCommit.call(host, tx, () => {
      assertFinalized();
    });
    if (returned !== undefined) fail();
    check();
  };
  const run = async <T>(work: () => Promise<T>): Promise<T> => {
    if (active || phase !== "Work") fail();
    active = true;
    try {
      await initialize();
      await fresh();
      const result = await work();
      check();
      active = false;
      return result;
    } catch (error) {
      failed = true;
      throw error;
    }
  };
  const registerChild = (actual: Transaction, guard: () => Promise<void>, final: () => void) => {
    if (actual !== tx || phase !== "Work") fail();
    return register.call(host, tx, guard, final);
  };
  const admission = async (
    actual: Transaction,
    packet: unknown,
    purpose: string,
    fields: readonly string[],
    mode: string,
  ) => {
    check();
    if (actual !== tx) fail();
    const p = readClosedRecord(packet, [
      "tenantReference",
      "brandReference",
      "storeReference",
      "actorReference",
      "permission",
      "purposeCode",
      "mode",
      "requiredFields",
      "command",
      "observedAt",
      "validUntil",
      ...(purpose === "STORE_SETUP_REFERENCE"
        ? ["kind"]
        : purpose === "STORE_PAYMENT_CONFIGURATION"
          ? ["currencyCode", "configurationReference"]
          : ["templateReference", "versionReference"]),
    ]);
    if (
      Object.entries(fixed).some(([k, v]) => p[k] !== v) ||
      p.permission !== "organization.manage" ||
      p.purposeCode !== purpose ||
      p.mode !== mode ||
      p.command !== null ||
      canonicalizeRfc8785(p.requiredFields) !== canonicalizeRfc8785(fields) ||
      typeof p.observedAt !== "string" ||
      p.observedAt < origin ||
      p.observedAt > check() ||
      typeof p.validUntil !== "string" ||
      p.validUntil > originalUntil
    )
      fail();
    await fresh();
    return Object.freeze({ validUntil: deadline });
  };
  const referenceReaders = new Map<
    string,
    ReturnType<typeof createPostgresStoreSetupReferenceStore>
  >();
  const reference = (kind: "Address" | "Contact", input: unknown) =>
    run(async () => {
      const ref = parseStoreAdministrationReference(input),
        key = kind + ref;
      let owner = referenceReaders.get(key);
      if (!owner) {
        owner = createPostgresStoreSetupReferenceStore({
          ...fixed,
          transaction: tx,
          clock: { now: check },
          originalObservedAt: origin,
          originalValidUntil: deadline,
          registerBeforeCommit: registerChild,
          references: { ...references, nextReference: () => fail() },
          appendAudit: async () => fail(),
          authority: {
            holdUntilTransactionCompletes: async (actual, p) => {
              if (p.kind !== kind) fail();
              return admission(
                actual,
                p,
                "STORE_SETUP_REFERENCE",
                storeSetupReferenceOperationRequiredFields,
                "ReadVersion",
              );
            },
          },
        });
        referenceReaders.set(key, owner);
        children.push(owner);
      }
      const value = await owner.readVersion({ kind, reference: ref });
      if (!value) fail("STORE_CONFIGURATION_ORIGINAL_VERSION_CONFLICT");
      return value;
    });
  const paymentReaders = new Map<
    string,
    ReturnType<typeof createPostgresStorePaymentConfigurationStore>
  >();
  const payment = (input: unknown) =>
    run(async () => {
      if (currency !== "CAD") fail();
      const ref = parseStoreAdministrationReference(input);
      let owner = paymentReaders.get(ref);
      if (!owner) {
        owner = createPostgresStorePaymentConfigurationStore({
          ...fixed,
          currencyCode: "CAD",
          transaction: tx,
          clock: { now: check },
          originalObservedAt: origin,
          originalValidUntil: deadline,
          registerBeforeCommit: registerChild,
          references: { ...references, nextReference: () => fail() },
          appendAudit: async () => fail(),
          authority: {
            holdUntilTransactionCompletes: async (actual, p) => {
              if (p.configurationReference !== ref || p.currencyCode !== currency) fail();
              return admission(
                actual,
                p,
                "STORE_PAYMENT_CONFIGURATION",
                storePaymentConfigurationRequiredFields,
                "ReadVersion",
              );
            },
          },
        });
        paymentReaders.set(ref, owner);
        children.push(owner);
      }
      const value = await owner.readVersion(ref);
      if (!value) fail("STORE_CONFIGURATION_ORIGINAL_VERSION_CONFLICT");
      return value;
    });
  const receipt = (input: unknown) =>
    run(async () => {
      const template = parseStoreAdministrationReference(input),
        existing = receiptReaders.get(template);
      if (existing) return existing.read();
      const deviceTx = Object.freeze({
        query: async (sql: string, values: readonly unknown[]) => {
          check();
          const result = await query.call(tx, sql, values);
          check();
          if (!result || typeof result !== "object") fail();
          const r = Object.getOwnPropertyDescriptor(result, "rows"),
            count = Object.getOwnPropertyDescriptor(result, "rowCount");
          if (
            !r?.enumerable ||
            !("value" in r) ||
            !Array.isArray(r.value) ||
            Object.getPrototypeOf(r.value) !== Array.prototype ||
            Reflect.ownKeys(r.value).length !== r.value.length + 1
          )
            fail();
          const rows = Array.from({ length: r.value.length }, (_, index) => {
            const d = Object.getOwnPropertyDescriptor(r.value, String(index));
            if (
              !d?.enumerable ||
              !("value" in d) ||
              !d.value ||
              typeof d.value !== "object" ||
              Object.getPrototypeOf(d.value) !== Object.prototype
            )
              fail();
            return readClosedRecord(d.value, Object.keys(d.value));
          });
          let rowCount: number | null | undefined;
          if (count) {
            if (!count.enumerable || !("value" in count)) fail();
            if (count.value === null) rowCount = null;
            else if (count.value !== undefined) {
              if (
                typeof count.value !== "number" ||
                !Number.isSafeInteger(count.value) ||
                count.value < 0
              )
                fail();
              rowCount = count.value;
            }
          }
          check();
          return { rows, ...(rowCount === undefined ? {} : { rowCount }) };
        },
      });
      const contents = new Map<string, DigitalReceiptTemplateAuthoredContent>();
      const proofs = new Map<
        string,
        ReturnType<typeof createPostgresReceiptTemplateContentPublicationProof>
      >();
      const publishing = createPostgresPublishingMutationStore(
        { run: async (work) => work(deviceTx) },
        parsePublishingReference(fixed.tenantReference),
        createPublishingScope({
          kind: "Store",
          brandReference: parsePublishingReference(fixed.brandReference),
          storeReference: parsePublishingReference(fixed.storeReference),
        }),
      );
      const contentFor = async (v: DigitalReceiptTemplateVersion) => {
        const ref = String(v.versionReference),
          old = contents.get(ref);
        if (old) return old;
        if (phase !== "Work") fail();
        const owner = createPostgresDigitalReceiptTemplateSubmissionStore({
          ...fixed,
          transaction: tx,
          clock: { now: check },
          originalObservedAt: origin,
          originalValidUntil: deadline,
          registerBeforeCommit: registerChild,
          references,
          readPublishingReview: async () => fail(),
          authority: {
            holdUntilTransactionCompletes: async (actual, p) => {
              if (p.templateReference !== template || p.versionReference !== ref) fail();
              return admission(
                actual,
                p,
                "RECEIPT_TEMPLATE_SUBMISSION",
                digitalReceiptTemplateSubmissionRequiredFields,
                "ReadAuthoredContent",
              );
            },
          },
        });
        children.push(owner);
        const value = await owner.readAuthoredContent({
          templateReference: template,
          versionReference: ref,
        });
        if (!value) fail();
        contents.set(ref, value);
        return value;
      };
      const owner = createPostgresDigitalReceiptTemplateStore({
        brandReference: fixed.brandReference,
        storeReference: fixed.storeReference,
        validatePublication: async () => fail(),
        authorize: async (actual, p) => {
          if (
            actual !== deviceTx ||
            p.action !== "Read" ||
            p.templateReference !== template ||
            p.brandReference !== fixed.brandReference ||
            p.storeReference !== fixed.storeReference
          )
            fail();
          await fresh();
          return true;
        },
        isCurrentPublication: async (actual, v, at) => {
          if (actual !== deviceTx || at < origin || at > check()) fail();
          const content = await contentFor(v);
          const current = await publishing.resolveCurrentRelease({
            familyReference: content.familyReference,
            configurationType: "RECEIPT_TEMPLATE",
            purposeCode: "RECEIPT_ISSUANCE",
            observedAt: at,
          });
          if (String(current.release.releaseId) !== String(v.publicationReference)) return false;
          let proof = proofs.get(String(v.versionReference));
          if (!proof) {
            if (phase !== "Work") fail();
            proof = createPostgresReceiptTemplateContentPublicationProof({
              ...fixed,
              familyReference: content.familyReference,
              configurationType: "RECEIPT_TEMPLATE",
              purposeCode: "RECEIPT_ISSUANCE",
              authorize: async (actual, observed) => {
                if (actual !== deviceTx || observed < origin || observed > check()) fail();
                await fresh();
                return true;
              },
              readAuthoredContent: async (actual, p) => {
                if (
                  actual !== deviceTx ||
                  p.tenantReference !== fixed.tenantReference ||
                  p.brandReference !== fixed.brandReference ||
                  p.storeReference !== fixed.storeReference ||
                  p.templateReference !== template ||
                  p.versionReference !== String(v.versionReference)
                )
                  fail();
                return content;
              },
            });
            proofs.set(String(v.versionReference), proof);
          }
          const packet = await proof(deviceTx, v, at);
          if (packet === null) fail();
          check();
          return true;
        },
      });
      const read = async () => {
        const value = await owner.resolve(deviceTx, {
          templateReference: template,
          locale,
          observedAt: check(),
        });
        check();
        return value;
      };
      const baseline = await read();
      receiptReaders.set(template, { read, baseline });
      return baseline;
    });
  const brandContent = (input: unknown) =>
    run(async () => {
      const p = readClosedRecord(input, [
        "configurationVersionReference",
        "expectedBrandVersion",
        "originalIntentDigest",
      ]);
      const request = parseTenantStoreBrandConfigurationContentRequest({
        tenantReference: fixed.tenantReference,
        brandReference: fixed.brandReference,
        actorReference: fixed.actorReference,
        purposeCode: "STORE_CONFIGURATION",
        configurationVersionReference: p.configurationVersionReference,
        expectedBrandVersion: p.expectedBrandVersion,
        originalIntentDigest: p.originalIntentDigest,
        observedAt: check(),
        validUntil: deadline,
      });
      const key = canonicalizeRfc8785({
        configurationVersionReference: request.configurationVersionReference,
        expectedBrandVersion: request.expectedBrandVersion,
        originalIntentDigest: request.originalIntentDigest,
      });
      const old = brandReads.get(key);
      if (old) return old.read();
      const resolveBrand = createMerchantBrandScope(persistence);
      const brandAuthority = async (
        actual: Transaction,
        r: TenantStoreBrandConfigurationContentRequest,
        fields: readonly string[],
      ) => {
        check();
        if (
          actual !== tx ||
          r.tenantReference !== fixed.tenantReference ||
          r.brandReference !== fixed.brandReference ||
          r.actorReference !== fixed.actorReference ||
          r.purposeCode !== "STORE_CONFIGURATION" ||
          canonicalizeRfc8785(r) !== canonicalizeRfc8785(request) ||
          canonicalizeRfc8785(fields) !==
            canonicalizeRfc8785(tenantBrandConfigurationRequiredFields)
        )
          fail();
        const current = await resolveBrand(tx, cookie, session);
        identity();
        if (
          String(current.tenantReference) !== fixed.tenantReference ||
          String(current.selectedStoreReference) !== fixed.storeReference ||
          String(current.context.brand.brandReference) !== fixed.brandReference ||
          String(current.actorReference) !== fixed.actorReference
        )
          fail("STORE_CONFIGURATION_ORIGINAL_PERMISSION_DENIED");
        const result = await current.authorizeActionsWithValidity(["organization.manage"]);
        identity();
        const decision = result?.decisions[0];
        if (
          !result ||
          result.decisions.length !== 1 ||
          !decision ||
          !Object.isFrozen(decision) ||
          decision.effect !== "Allow" ||
          decision.action !== "organization.manage" ||
          decision.scopeKind !== "Brand"
        )
          fail("STORE_CONFIGURATION_ORIGINAL_PERMISSION_DENIED");
        retain(result.validUntil);
        await fresh();
        return true;
      };
      const recorded = createPostgresTenantStoreBrandConfigurationContentSource({
        brandReference: fixed.brandReference,
        clock: check,
        transactions: { run: async (work) => work(tx) },
        authority: {
          withCurrentContentRead: async (r, fields, work) => {
            await brandAuthority(tx, r, fields);
            const value = await work();
            await brandAuthority(tx, r, fields);
            return value;
          },
          isCurrent: brandAuthority,
        },
      });
      const current = createCurrentStoreBrandConfigurationContentSource(recorded);
      const read = async () =>
        current.withCurrentContent(request, async (value, actual) => {
          if (
            actual !== tx ||
            value.tenantReference !== fixed.tenantReference ||
            value.brandReference !== fixed.brandReference ||
            value.configurationVersionReference !== request.configurationVersionReference ||
            value.brandVersion !== request.expectedBrandVersion ||
            !value.supportedLocales.includes(locale)
          )
            fail("STORE_CONFIGURATION_ORIGINAL_VERSION_CONFLICT");
          retain(value.validUntil);
          return value;
        });
      const baseline = await read();
      brandReads.set(key, { read, baseline });
      return baseline;
    });
  const assertFinalized = () => {
    check();
    if (phase !== "Final" || guards !== 1 || finals !== 1 || active) fail();
    for (const owner of children) {
      const until = owner.assertFinalized(tx);
      retain(until);
    }
    check();
    return deadline;
  };
  return Object.freeze({
    address: (ref: unknown) => reference("Address", ref),
    contact: (ref: unknown) => reference("Contact", ref),
    payment,
    receipt,
    brand: brandContent,
    assertFinalized,
  });
}
