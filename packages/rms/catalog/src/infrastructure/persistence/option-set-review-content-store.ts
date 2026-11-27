import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  validateAuditRecord,
  type AppendAuditRecordInput,
} from "@bop/audit";
import { appendEventInTransaction, type DomainEventEnvelope } from "@bop/eventing";
import {
  CatalogError,
  parseCatalogInstant,
  parseCatalogReference,
} from "../../contracts/product.js";
import { copyCategoryPersistenceValue } from "../../contracts/category-persistence.js";
import { parseCatalogFullOptionSetPublicationContent } from "../../contracts/option-set-editor-content.js";
import {
  parseCatalogOptionSetReviewRecord,
  parseCatalogOptionSetReleaseRecord,
  type CatalogOptionSetReviewRecord,
  type CatalogOptionSetReleaseRecord,
} from "../../contracts/option-set-review-record.js";
import {
  createPostgresCurrentFullOptionSetDraftStore,
  createPostgresFullOptionSetSealHandoffStore,
  parseFullOptionSetPublicationSealIdentity,
  type FullOptionSetPublicationSealIdentity,
  type FrozenFullOptionSetContentAuthority,
  type CurrentFullOptionSetDraftAuthority,
} from "./option-set-full-draft-store.js";
import type { ProductLifecycleTransaction as Transaction } from "./product-lifecycle-store.js";

export const optionSetReviewRecordFields = Object.freeze([
  "profile",
  "operationReference",
  "sourceOperationReference",
  "lifecycleReference",
  "actorReference",
  "auditReference",
  "reasonCode",
  "recordedAt",
  "binding",
  "content",
  "digest",
] as const);
export const optionSetReleaseRecordFields = Object.freeze([
  "profile",
  "tenantReference",
  "brandReference",
  "optionSetReference",
  "versionReference",
  "operationReference",
  "reviewOperationReference",
  "reviewRecordDigest",
  "reviewBindingDigest",
  "sealOperationReference",
  "sealRecordDigest",
  "publishingOperationReference",
  "actorReference",
  "auditReference",
  "reasonCode",
  "recordedAt",
  "release",
  "digest",
] as const);
type RecordValue = CatalogOptionSetReviewRecord | CatalogOptionSetReleaseRecord;
type Kind = "Review" | "Release";
export interface OptionSetReviewContentAuthority {
  /** Real current Actor/scope/fields permission held to outer COMMIT. Apply must
   * additionally hold actual original review intent or Publishing release proof.
   * This store never supplies policy, validation, approval or current eligibility. */
  holdUntilTransactionCompletes(
    tx: Transaction,
    input: {
      readonly tenantReference: string;
      readonly brandReference: string;
      readonly actorReference: string;
      readonly actorKind: "User";
      readonly permission: "catalog.manage";
      readonly action:
        "catalog.option_set.read" | "catalog.option_set.submit" | "catalog.option_set.publish";
      readonly purposeCode:
        "CATALOG_OPTION_SET_REVIEW_RECORD" | "CATALOG_OPTION_SET_RELEASE_RECORD";
      readonly phase: "Read" | "Intent" | "Apply" | "Replay";
      readonly optionSetReference: string;
      readonly requiredFields: readonly string[];
      readonly record: RecordValue | null;
      readonly observedAt: string;
    },
  ): Promise<{ readonly observedAt: string; readonly validUntil: string }>;
}
const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
const same = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
/** Caller owns the outer transaction; binding, seal, Publishing mutation and this
 * append are atomic only when every owning factory is bound to that same tx. */
export function createPostgresOptionSetReviewContentStore(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly clock: { now(): string };
  readonly authority: OptionSetReviewContentAuthority;
  /** Required only for current Draft review discovery; no caller-supplied source tuple. */
  readonly currentDraftAuthority?: CurrentFullOptionSetDraftAuthority;
  readonly publicationSeal?: {
    readonly identity: FullOptionSetPublicationSealIdentity;
    readonly originalObservedAt: string;
    readonly originalValidUntil: string;
    readonly currentDraftAuthority: CurrentFullOptionSetDraftAuthority;
    readonly frozenAuthority: FrozenFullOptionSetContentAuthority;
  };
  readonly registerBeforeCommit: (
    tx: Transaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void> | void;
  readonly events: { generateReference(): string };
}) {
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference);
  if (
    typeof options.clock?.now !== "function" ||
    typeof options.authority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.registerBeforeCommit !== "function" ||
    typeof options.events?.generateReference !== "function"
  )
    return fail("CATALOG_INPUT_INVALID");
  const clock = options.clock.now.bind(options.clock),
    admission = options.authority.holdUntilTransactionCompletes.bind(options.authority),
    register = options.registerBeforeCommit.bind(options),
    eventReference = options.events.generateReference.bind(options.events),
    currentDraftAdmission = options.currentDraftAuthority?.holdUntilTransactionCompletes.bind(
      options.currentDraftAuthority,
    );
  const seal = options.publicationSeal;
  if (seal !== undefined) {
    const expected = [
      "identity",
      "originalObservedAt",
      "originalValidUntil",
      "currentDraftAuthority",
      "frozenAuthority",
    ];
    if (
      !seal ||
      typeof seal !== "object" ||
      (Object.getPrototypeOf(seal) !== Object.prototype && Object.getPrototypeOf(seal) !== null) ||
      Reflect.ownKeys(seal).length !== expected.length ||
      expected.some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(seal, key);
        return !descriptor || !("value" in descriptor) || !descriptor.enumerable;
      }) ||
      Reflect.ownKeys(seal).some((key) => typeof key !== "string" || !expected.includes(key))
    )
      return fail("CATALOG_INPUT_INVALID");
    if (
      typeof seal.currentDraftAuthority?.holdUntilTransactionCompletes !== "function" ||
      typeof seal.frozenAuthority?.holdUntilTransactionCompletes !== "function"
    )
      return fail("CATALOG_INPUT_INVALID");
  }
  const sealIdentity = seal ? parseFullOptionSetPublicationSealIdentity(seal.identity) : undefined;
  const sealObservedAt = seal ? parseCatalogInstant(seal.originalObservedAt) : undefined,
    sealValidUntil = seal ? parseCatalogInstant(seal.originalValidUntil) : undefined;
  const handoffCurrent = seal?.currentDraftAuthority.holdUntilTransactionCompletes.bind(
      seal.currentDraftAuthority,
    ),
    handoffFrozen = seal?.frozenAuthority.holdUntilTransactionCompletes.bind(seal.frozenAuthority);
  const now = () => parseCatalogInstant(clock());
  interface HostState {
    tx: Transaction;
    originalQuery: Transaction["query"];
    query: Transaction["query"];
    latest: string;
    deadline: number;
    poisoned: boolean;
    closed: boolean;
    initializing: boolean;
    pending: number;
    guardCalls: number;
    guardComplete: boolean;
    holds: (() => Promise<void>)[];
    ownReviewReceipts: Map<string, ReturnType<typeof parseCatalogOptionSetReviewRecord>>;
    draftReviews: Map<
      string,
      {
        readonly owner: ReturnType<typeof createPostgresFullOptionSetSealHandoffStore>;
        readonly original: Awaited<
          ReturnType<
            ReturnType<typeof createPostgresCurrentFullOptionSetDraftStore>["readCurrentForReview"]
          >
        >;
        admitted: boolean;
      }
    >;
  }
  const hosts = new WeakMap<Transaction, HostState>();
  function check(state: HostState) {
    const descriptor = Object.getOwnPropertyDescriptor(state.tx, "query");
    if (
      state.poisoned ||
      state.closed ||
      state.initializing ||
      !descriptor ||
      !("value" in descriptor) ||
      descriptor.value !== state.originalQuery ||
      hosts.get(state.tx) !== state
    ) {
      state.poisoned = true;
      return fail();
    }
    const at = now();
    if (at < state.latest || Date.parse(at) >= state.deadline) {
      state.poisoned = true;
      return fail();
    }
    state.latest = at;
    return at;
  }
  async function execute<T>(tx: Transaction, work: () => Promise<T>): Promise<T> {
    let state = hosts.get(tx);
    if (!state) {
      const descriptor = Object.getOwnPropertyDescriptor(tx, "query");
      if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function")
        return fail();
      const originalQuery: Transaction["query"] = descriptor.value;
      state = {
        tx,
        originalQuery,
        query: originalQuery.bind(tx),
        latest: "",
        deadline: 0,
        poisoned: false,
        closed: false,
        initializing: true,
        pending: 0,
        guardCalls: 0,
        guardComplete: false,
        holds: [],
        draftReviews: new Map(),
        ownReviewReceipts: new Map(),
      };
      hosts.set(tx, state);
      const original = state;
      try {
        const registered: unknown = await register(
          tx,
          async () => {
            try {
              original.guardCalls++;
              if (original.pending !== 0 || original.guardCalls !== 1) return fail();
              check(original);
              for (const hold of original.holds) await hold();
              check(original);
              original.guardComplete = true;
            } catch (error) {
              original.poisoned = true;
              throw error;
            }
          },
          () => {
            if (original.pending !== 0 || original.guardCalls !== 1 || !original.guardComplete) {
              original.poisoned = true;
              return fail();
            }
            check(original);
            original.closed = true;
          },
        );
        if (registered !== undefined) return fail();
        const first = now();
        original.latest = first;
        original.deadline = Date.parse(first) + 30000;
        original.initializing = false;
      } catch (error) {
        original.poisoned = true;
        throw error;
      }
    }
    const original = state;
    original.pending++;
    try {
      check(original);
      if (original.guardCalls !== 0) return fail();
      const result = await work();
      check(original);
      return result;
    } catch (error) {
      original.poisoned = true;
      throw error;
    } finally {
      original.pending--;
    }
  }
  async function query<Row = Record<string, unknown>>(
    tx: Transaction,
    sql: string,
    values: readonly unknown[],
  ) {
    const state = hosts.get(tx);
    if (!state) return fail();
    check(state);
    const result = await state.query<Row>(sql, values);
    check(state);
    return result;
  }
  function scope(record: RecordValue) {
    const identity = record.profile === "CatalogOptionSetReviewRecordV1" ? record.binding : record;
    if (identity.tenantReference !== tenant || identity.brandReference !== brand) return fail();
    return identity;
  }
  function checkpoint(tx: Transaction, kind: Kind, set: string) {
    const state = hosts.get(tx);
    if (!state) return fail();
    let retainedPhase: "Read" | "Intent" | "Apply" | "Replay" = "Read",
      retainedRecord: RecordValue | null = null;
    const hold = async (
      phase: "Read" | "Intent" | "Apply" | "Replay",
      record: RecordValue | null,
    ) => {
      const at = check(state);
      const raw = copyCategoryPersistenceValue(
        await admission(tx, {
          tenantReference: tenant,
          brandReference: brand,
          actorReference: actor,
          actorKind: "User",
          permission: "catalog.manage",
          action:
            phase === "Read"
              ? "catalog.option_set.read"
              : kind === "Review"
                ? "catalog.option_set.submit"
                : "catalog.option_set.publish",
          purposeCode:
            kind === "Review"
              ? "CATALOG_OPTION_SET_REVIEW_RECORD"
              : "CATALOG_OPTION_SET_RELEASE_RECORD",
          phase,
          optionSetReference: set,
          requiredFields:
            kind === "Review" ? optionSetReviewRecordFields : optionSetReleaseRecordFields,
          record: record === null ? null : (copyCategoryPersistenceValue(record) as RecordValue),
          observedAt: at,
        }),
      );
      if (
        !raw ||
        typeof raw !== "object" ||
        Array.isArray(raw) ||
        Object.keys(raw).length !== 2 ||
        !Object.hasOwn(raw, "observedAt") ||
        !Object.hasOwn(raw, "validUntil")
      )
        return fail();
      const proof = raw as Record<string, unknown>,
        observed = parseCatalogInstant(proof.observedAt),
        until = parseCatalogInstant(proof.validUntil);
      if (observed !== at || until <= observed || Date.parse(until) - Date.parse(observed) > 30000)
        return fail();
      state.deadline = Math.min(state.deadline, Date.parse(until));
      check(state);
      retainedPhase = phase;
      retainedRecord = record;
    };
    if (state.holds.length >= 32) return fail();
    state.holds.push(() => hold(retainedPhase, retainedRecord));
    return { check: () => check(state), hold };
  }
  const setup = async (tx: Transaction) => {
    await query(
      tx,
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
      [tenant, brand],
    );
  };
  const parse = (kind: Kind, value: unknown): RecordValue =>
    kind === "Review"
      ? parseCatalogOptionSetReviewRecord(value)
      : parseCatalogOptionSetReleaseRecord(value);
  const table = (kind: Kind) =>
    kind === "Review"
      ? "rms_catalog.option_set_review_content"
      : "rms_catalog.option_set_publication_release";
  async function find(tx: Transaction, kind: Kind, operation: string) {
    const result = await query<{ snapshot: unknown }>(
      tx,
      `SELECT snapshot_json snapshot FROM ${table(kind)} WHERE tenant_id=$1 AND brand_id=$2 AND operation_id=$3`,
      [tenant, brand, operation],
    );
    if (result.rows.length > 1) return fail();
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (!row) return fail();
    const record = parse(kind, row.snapshot);
    scope(record);
    if (record.operationReference !== operation) return fail();
    return record;
  }
  async function coherent(tx: Transaction, record: RecordValue) {
    const identity = scope(record);
    if (record.profile === "CatalogOptionSetReviewRecordV1") {
      const source = await query<{
        snapshot: unknown;
        source_digest: string;
        content_digest: string;
        configuration_digest: string;
      }>(
        tx,
        "SELECT snapshot_json snapshot,source_digest,content_digest,configuration_digest FROM rms_catalog.option_set_draft_content_snapshot WHERE tenant_id=$1 AND brand_id=$2 AND operation_id=$3 AND option_set_id=$4 AND option_set_version_id=$5 AND result_aggregate_version=$6",
        [
          tenant,
          brand,
          record.sourceOperationReference,
          identity.optionSetReference,
          identity.versionReference,
          record.binding.expectedAggregateVersion,
        ],
      );
      const row = source.rows[0];
      if (
        source.rows.length !== 1 ||
        !row ||
        !same(row.snapshot, record.content) ||
        row.source_digest !== record.binding.sourceDigest ||
        row.content_digest !== record.binding.contentDigest ||
        row.configuration_digest !== record.binding.configurationDigest
      )
        return fail();
      return record.binding.expectedAggregateVersion;
    } else {
      const review = await find(tx, "Review", record.reviewOperationReference);
      if (
        !review ||
        review.profile !== "CatalogOptionSetReviewRecordV1" ||
        review.digest !== record.reviewRecordDigest ||
        review.binding.digest !== record.reviewBindingDigest ||
        review.binding.optionSetReference !== record.optionSetReference ||
        review.binding.versionReference !== record.versionReference ||
        String(record.release.sourceLifecycleId) !== review.lifecycleReference ||
        String(record.recordedAt) < String(review.recordedAt)
      )
        return fail();
      const source = await query<{ snapshot: unknown }>(
        tx,
        "SELECT snapshot_json snapshot FROM rms_catalog.option_set_publication_content WHERE tenant_id=$1 AND brand_id=$2 AND operation_id=$3 AND option_set_id=$4 AND option_set_version_id=$5",
        [
          tenant,
          brand,
          record.sealOperationReference,
          record.optionSetReference,
          record.versionReference,
        ],
      );
      const row = source.rows[0];
      if (source.rows.length !== 1 || !row) return fail();
      const sealed = parseCatalogFullOptionSetPublicationContent(row.snapshot);
      if (
        sealed.digest !== record.sealRecordDigest ||
        !same(sealed.editorContent, review.content) ||
        sealed.sourceDigest !== review.binding.sourceDigest ||
        sealed.contentDigest !== review.binding.contentDigest ||
        sealed.configurationDigest !== review.binding.configurationDigest ||
        sealed.supportedContent.sealedAt < review.recordedAt ||
        sealed.supportedContent.sealedAt > record.recordedAt
      )
        return fail();
      return sealed.supportedContent.sourceAggregateVersion + 1;
    }
  }
  async function read(tx: Transaction, kind: Kind, operationValue: string, setValue: string) {
    const operation = parseCatalogReference(operationValue),
      set = parseCatalogReference(setValue),
      gate = checkpoint(tx, kind, set);
    await gate.hold("Read", null);
    await setup(tx);
    const record = await find(tx, kind, operation);
    if (record !== null) {
      if (scope(record).optionSetReference !== set) return fail();
      await coherent(tx, record);
    }
    await gate.hold("Read", record);
    return record;
  }
  /** Stored Review discovery only. Current Publishing lifecycle, policy and
   * independent approval are separate owning proofs for every consumer. */
  async function readCurrentReviewForDraft(tx: Transaction, value: unknown) {
    const copied = copyCategoryPersistenceValue(value);
    if (!copied || typeof copied !== "object" || Array.isArray(copied))
      return fail("CATALOG_INPUT_INVALID");
    const request = copied as Record<string, unknown>;
    if (
      Object.keys(request).length !== 2 ||
      !Object.hasOwn(request, "optionSetReference") ||
      !Object.hasOwn(request, "expectedAggregateVersion")
    )
      return fail("CATALOG_INPUT_INVALID");
    const set = parseCatalogReference(request.optionSetReference),
      expected = request.expectedAggregateVersion;
    if (
      expected !== null &&
      (!Number.isSafeInteger(expected) ||
        (expected as number) < 1 ||
        (expected as number) > 2147483647)
    )
      return fail("CATALOG_INPUT_INVALID");
    if (!currentDraftAdmission) return fail();
    const state = hosts.get(tx);
    if (!state) return fail();
    const gate = checkpoint(tx, "Review", set);
    await gate.hold("Read", null);
    const draftStore = createPostgresCurrentFullOptionSetDraftStore({
      tenantReference: tenant,
      brandReference: brand,
      actorReference: actor,
      clock: { now: clock },
      transactions: { run: (work) => work(tx) },
      authority: { holdUntilTransactionCompletes: currentDraftAdmission },
    });
    const readRoot = async () => {
      const current = await draftStore.readCurrentForReview({
        optionSetReference: set,
        expectedAggregateVersion: expected,
      });
      check(state);
      state.deadline = Math.min(state.deadline, Date.parse(current.validUntil));
      check(state);
      return current;
    };
    const original = await readRoot();
    // Match saveReview's source-before-review lock order. Row/source locks from
    // the genuine current reader remain held on this same outer transaction.
    await setup(tx);
    await query(tx, "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [
      "CatalogOptionCurrentReview:" + tenant + ":" + brand + ":" + set,
    ]);
    const discover = async () => {
      const found = await query<{
        operation_id: unknown;
        option_set_id: unknown;
        option_set_version_id: unknown;
        source_operation_id: unknown;
        lifecycle_id: unknown;
        binding_digest: unknown;
        record_digest: unknown;
        recorded_at: unknown;
        snapshot: unknown;
      }>(
        tx,
        `SELECT operation_id,option_set_id,option_set_version_id,source_operation_id,lifecycle_id,binding_digest,record_digest,to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') recorded_at,snapshot_json snapshot FROM rms_catalog.option_set_review_content WHERE tenant_id=$1 AND brand_id=$2 AND option_set_id=$3 AND option_set_version_id=$4 AND source_operation_id=$5 ORDER BY rms_catalog.option_set_review_content.recorded_at DESC,operation_id DESC LIMIT 2`,
        [
          tenant,
          brand,
          set,
          original.content.sourceAggregate.draft.versionReference,
          original.sourceOperationReference,
        ],
      );
      if (found.rows.length > 2) return fail();
      const records = found.rows.map((row) => {
        const record = parseCatalogOptionSetReviewRecord(row.snapshot),
          binding = scope(record);
        if (
          record.operationReference !== row.operation_id ||
          binding.optionSetReference !== row.option_set_id ||
          binding.versionReference !== row.option_set_version_id ||
          record.sourceOperationReference !== row.source_operation_id ||
          record.lifecycleReference !== row.lifecycle_id ||
          record.binding.digest !== row.binding_digest ||
          record.digest !== row.record_digest ||
          record.recordedAt !== row.recorded_at ||
          record.recordedAt > check(state) ||
          binding.optionSetReference !== set ||
          binding.versionReference !== original.content.sourceAggregate.draft.versionReference ||
          record.sourceOperationReference !== original.sourceOperationReference ||
          record.binding.expectedAggregateVersion !==
            original.content.sourceAggregate.aggregateVersion ||
          record.binding.sourceDigest !== original.sourceDigest ||
          record.binding.contentDigest !== original.contentDigest ||
          record.binding.configurationDigest !== original.configurationDigest ||
          !same(record.content, original.content)
        )
          return fail();
        return record;
      });
      const first = records[0],
        second = records[1];
      if (
        second &&
        (!first ||
          first.recordedAt <= second.recordedAt ||
          first.operationReference === second.operationReference)
      )
        return fail();
      const record = first ?? null;
      if (record) await coherent(tx, record);
      return record;
    };
    const selected = await discover();
    await gate.hold("Read", selected);
    if (state.holds.length >= 32) return fail();
    if (sealIdentity) {
      if (
        !sealObservedAt ||
        !sealValidUntil ||
        !handoffCurrent ||
        !handoffFrozen ||
        state.draftReviews.has(set)
      )
        return fail();
      const owner = createPostgresFullOptionSetSealHandoffStore({
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        originalObservedAt: sealObservedAt,
        originalValidUntil: sealValidUntil,
        sealIdentity,
        clock: { now: () => check(state) },
        transactions: {
          async run(work) {
            check(state);
            const answer = await work(tx);
            check(state);
            return answer;
          },
        },
        currentDraftAuthority: {
          async holdUntilTransactionCompletes(actual, input) {
            if (actual !== tx) return fail();
            return handoffCurrent(tx, input);
          },
        },
        frozenAuthority: {
          async holdUntilTransactionCompletes(actual, input) {
            if (actual !== tx) return fail();
            return handoffFrozen(tx, input);
          },
        },
      });
      state.draftReviews.set(set, { owner, original, admitted: false });
    }
    state.holds.push(async () => {
      const handoff = state.draftReviews.get(set);
      if (handoff?.admitted) {
        const proof = await handoff.owner.revalidate();
        state.deadline = Math.min(state.deadline, Date.parse(proof.validUntil));
        check(state);
        const retained = await discover();
        if (!same(retained, selected)) return fail();
        await gate.hold("Read", selected);
        return;
      }
      const current = await readRoot();
      if (
        !same(current.sourceSnapshotTuple, original.sourceSnapshotTuple) ||
        current.sourceOperationReference !== original.sourceOperationReference ||
        current.sourceDigest !== original.sourceDigest ||
        current.contentDigest !== original.contentDigest ||
        current.configurationDigest !== original.configurationDigest ||
        !same(current.content, original.content)
      )
        return fail();
      const retained = await discover();
      if (same(retained, selected)) return;
      if (selected !== null || retained === null) return fail();
      // A first absent read can move only to the receipt this very owner
      // successfully appended on this captured transaction. Historical replay
      // or a caller-supplied record cannot grant this admission.
      const own = [...state.ownReviewReceipts.values()].filter(
        (record) => record.binding.optionSetReference === set,
      );
      const receipt = own[0];
      if (
        own.length !== 1 ||
        !receipt ||
        !same(retained, receipt) ||
        receipt.actorReference !== actor ||
        receipt.sourceOperationReference !== original.sourceOperationReference ||
        receipt.binding.tenantReference !== tenant ||
        receipt.binding.brandReference !== brand ||
        receipt.binding.versionReference !==
          original.content.sourceAggregate.draft.versionReference ||
        receipt.binding.expectedAggregateVersion !==
          original.content.sourceAggregate.aggregateVersion ||
        receipt.binding.sourceDigest !== original.sourceDigest ||
        receipt.binding.contentDigest !== original.contentDigest ||
        receipt.binding.configurationDigest !== original.configurationDigest ||
        !same(receipt.content, original.content)
      )
        return fail();
      await gate.hold("Read", receipt);
    });
    return selected;
  }
  async function readForPublication(tx: Transaction, publicationValue: string, setValue: string) {
    const publication = parseCatalogReference(publicationValue),
      set = parseCatalogReference(setValue),
      gate = checkpoint(tx, "Release", set);
    await gate.hold("Read", null);
    await setup(tx);
    const result = await query<{ snapshot: unknown }>(
      tx,
      "SELECT snapshot_json snapshot FROM rms_catalog.option_set_publication_release WHERE tenant_id=$1 AND brand_id=$2 AND release_id=$3 AND option_set_id=$4",
      [tenant, brand, publication, set],
    );
    if (result.rows.length > 1) return fail();
    const row = result.rows[0];
    if (result.rows.length !== 0 && !row) return fail();
    const record = row === undefined ? null : parseCatalogOptionSetReleaseRecord(row.snapshot);
    if (record !== null) {
      if (
        scope(record).optionSetReference !== set ||
        String(record.release.releaseId) !== publication
      )
        return fail();
      await coherent(tx, record);
    }
    await gate.hold("Read", record);
    return record;
  }
  async function save(
    tx: Transaction,
    kind: Kind,
    value: unknown,
    auditInput: AppendAuditRecordInput,
  ) {
    const record = parse(kind, value),
      identity = scope(record),
      gate = checkpoint(tx, kind, identity.optionSetReference);
    if (record.actorReference !== actor || record.recordedAt > gate.check()) return fail();
    const audit = validateAuditRecord(copyCategoryPersistenceValue(auditInput));
    const actionCode =
      kind === "Review"
        ? "CATALOG_OPTION_SET_REVIEW_RECORDED"
        : "CATALOG_OPTION_SET_RELEASE_RECORDED";
    if (
      audit.auditId !== record.auditReference ||
      audit.brandId !== brand ||
      audit.storeId !== undefined ||
      audit.actor.type !== "User" ||
      audit.actor.reference !== actor ||
      audit.actionCode !== actionCode ||
      audit.targetType !== "CatalogOptionSet" ||
      audit.targetId !== identity.optionSetReference ||
      audit.occurredAt !== record.recordedAt ||
      audit.correlationId !== record.operationReference ||
      audit.reasonCode !== record.reasonCode ||
      audit.beforeSummary !== undefined ||
      audit.afterSummary !== undefined ||
      audit.correctsAuditId !== undefined
    )
      return fail();
    await gate.hold("Intent", record);
    await setup(tx);
    if (kind === "Review") {
      await query(tx, "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [
        "CatalogFullOptionSource:" + brand + ":" + identity.optionSetReference,
      ]);
      await query(tx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "CatalogOptionCurrentReview:" + tenant + ":" + brand + ":" + identity.optionSetReference,
      ]);
    }
    await query(tx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "CatalogOptionReviewOperation:" + tenant + ":" + brand + ":" + record.operationReference,
    ]);
    const old = await find(tx, kind, record.operationReference);
    if (old) {
      if (!same(old, record)) return fail("CATALOG_IDEMPOTENCY_CONFLICT");
      await coherent(tx, old);
      await gate.hold("Replay", old);
      return Object.freeze({ status: "Replayed" as const, record: old });
    }
    const aggregateVersion = await coherent(tx, record);
    await gate.hold("Apply", record);
    const values =
      kind === "Review" && record.profile === "CatalogOptionSetReviewRecordV1"
        ? [
            record.operationReference,
            tenant,
            brand,
            identity.optionSetReference,
            identity.versionReference,
            record.sourceOperationReference,
            record.lifecycleReference,
            record.binding.digest,
            record.digest,
            record.recordedAt,
            canonicalizeRfc8785(record),
          ]
        : record.profile === "CatalogOptionSetReleaseRecordV1"
          ? [
              record.operationReference,
              tenant,
              brand,
              record.optionSetReference,
              record.versionReference,
              record.reviewOperationReference,
              record.sealOperationReference,
              String(record.release.releaseId),
              record.reviewBindingDigest,
              record.sealRecordDigest,
              record.digest,
              record.recordedAt,
              canonicalizeRfc8785(record),
            ]
          : fail();
    const sql =
      kind === "Review"
        ? "INSERT INTO rms_catalog.option_set_review_content(operation_id,tenant_id,brand_id,option_set_id,option_set_version_id,source_operation_id,lifecycle_id,binding_digest,record_digest,recorded_at,snapshot_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)"
        : "INSERT INTO rms_catalog.option_set_publication_release(operation_id,tenant_id,brand_id,option_set_id,option_set_version_id,review_operation_id,seal_operation_id,release_id,binding_digest,seal_record_digest,record_digest,recorded_at,snapshot_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)";
    if ((await query(tx, sql, values)).rowCount !== 1) return fail();
    await appendAuditRecordInTransaction({ query: (sql, values) => query(tx, sql, values) }, audit);
    const event: DomainEventEnvelope = {
      eventId: parseCatalogReference(eventReference()),
      eventType:
        kind === "Review"
          ? "OptionSetReviewContentRecorded"
          : "OptionSetPublicationReleaseRecorded",
      schemaVersion: 1,
      occurredAt: record.recordedAt,
      producerModule: "@rms/catalog",
      tenantId: brand,
      aggregateType: "CatalogOptionSet",
      aggregateId: identity.optionSetReference,
      aggregateVersion: BigInt(aggregateVersion),
      correlationId: record.operationReference,
      actor: { type: "Actor", actorId: actor },
      payload: { operationReference: record.operationReference, recordDigest: record.digest },
      redactionClassification: "indirect_identifier",
      replayMetadata: { operationReference: record.operationReference },
    };
    await appendEventInTransaction(
      {
        query: async (sql, values) => {
          const result = await query(tx, sql, values);
          return { rowCount: result.rowCount ?? null };
        },
      },
      event,
    );
    await gate.hold("Apply", record);
    return Object.freeze({ status: "Recorded" as const, record });
  }
  return Object.freeze({
    saveReview: (tx: Transaction, value: unknown, audit: AppendAuditRecordInput) =>
      execute(tx, async () => {
        const result = await save(tx, "Review", value, audit);
        const record = parseCatalogOptionSetReviewRecord(result.record),
          state = hosts.get(tx);
        if (!state) return fail();
        if (result.status === "Recorded") {
          if (
            state.ownReviewReceipts.size >= 32 ||
            state.ownReviewReceipts.has(record.operationReference)
          )
            return fail();
          state.ownReviewReceipts.set(record.operationReference, record);
        }
        return Object.freeze({ status: result.status, record });
      }),
    saveRelease: (tx: Transaction, value: unknown, audit: AppendAuditRecordInput) =>
      execute(tx, async () => {
        const result = await save(tx, "Release", value, audit);
        return Object.freeze({
          status: result.status,
          record: parseCatalogOptionSetReleaseRecord(result.record),
        });
      }),
    admitOwnSeal: (tx: Transaction, receipt: unknown) =>
      execute(tx, async () => {
        const state = hosts.get(tx);
        if (!state || !sealIdentity) return fail();
        const copied = copyCategoryPersistenceValue(receipt);
        if (
          !copied ||
          typeof copied !== "object" ||
          Array.isArray(copied) ||
          !Object.hasOwn(copied, "content")
        )
          return fail();
        const content = parseCatalogFullOptionSetPublicationContent(
            (copied as Record<string, unknown>).content,
          ),
          held = state.draftReviews.get(content.supportedContent.optionSetReference);
        if (!held || held.admitted) return fail();
        const proof = await held.owner.admit(held.original, receipt);
        state.deadline = Math.min(state.deadline, Date.parse(proof.validUntil));
        check(state);
        held.admitted = true;
        return proof;
      }),
    readCurrentReviewForDraft: (tx: Transaction, value: unknown) =>
      execute(tx, () => readCurrentReviewForDraft(tx, value)),
    readReview: (tx: Transaction, operation: string, set: string) =>
      execute(tx, async () => {
        const record = await read(tx, "Review", operation, set);
        return record === null ? null : parseCatalogOptionSetReviewRecord(record);
      }),
    readReleaseForPublication: (tx: Transaction, publication: string, set: string) =>
      execute(tx, () => readForPublication(tx, publication, set)),
    readRelease: (tx: Transaction, operation: string, set: string) =>
      execute(tx, async () => {
        const record = await read(tx, "Release", operation, set);
        return record === null ? null : parseCatalogOptionSetReleaseRecord(record);
      }),
  });
}
