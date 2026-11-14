import {
  CatalogError,
  parseCatalogInstant,
  parseCatalogReference,
  parseProductOptionBinding,
  copyCategoryPersistenceValue,
  assessCatalogFullProductOptionBindingPrerequisites,
  evaluateCatalogFullProductOptionBindingRules,
  createPostgresFrozenFullOptionSetContentStore,
  createPostgresProductPublicationFrozenFullOptionSetContentStore,
  parseProductPublicationCommandV2,
  parseCatalogProductPublicationWarningAcknowledgementCommand,
} from "@rms/catalog";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
type ReaderOptions = Parameters<typeof createPostgresFrozenFullOptionSetContentStore>[0];
type Transaction = Parameters<ReaderOptions["authority"]["holdUntilTransactionCompletes"]>[0];
type Observation = Awaited<
  ReturnType<ReturnType<typeof createPostgresFrozenFullOptionSetContentStore>["readPinned"]>
>;
type Evaluation = ReturnType<typeof assessCatalogFullProductOptionBindingPrerequisites>;
export interface FrozenFullOptionBindingRuleAssessment {
  readonly profile: "FrozenFullOptionBindingRuleAssessmentV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly bindingReference: string;
  readonly bindingDigest: string;
  readonly rootOptionSetReference: string;
  readonly rootVersionReference: string;
  readonly graphDigest: string;
  readonly sourceRecords: readonly {
    readonly optionSetReference: string;
    readonly versionReference: string;
    readonly recordDigest: string;
    readonly observedAt: string;
  }[];
  readonly rules: {
    readonly status: Evaluation["status"];
    readonly reason: string | null;
    readonly searchNodes: number;
  };
  readonly observedAt: string;
  readonly validUntil: string;
  readonly publishValidation: "Incomplete";
  readonly referenceEligibility: "NotEvaluated";
  readonly eligibility: "NotEvaluated";
  readonly digest: string;
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
/** Exact immutable owning records in one caller transaction. Frozen history does
 * not establish current Published, applicability, approval or sale qualification. */
type PublicationReaderOptions = Parameters<
  typeof createPostgresProductPublicationFrozenFullOptionSetContentStore
>[0];
interface GraphOptions {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly clock: { now(): string };
  readonly defaultQuantityAssessment?: "Prerequisites";
}
type Reader = ReturnType<typeof createPostgresFrozenFullOptionSetContentStore>;
export function createFrozenFullOptionBindingRuleSource(
  options: Omit<ReaderOptions, "transactions"> & {
    readonly defaultQuantityAssessment?: "Prerequisites";
  },
) {
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference),
    clock = options.clock,
    authority = options.authority;
  if (
    typeof clock?.now !== "function" ||
    typeof authority?.holdUntilTransactionCompletes !== "function"
  )
    return fail();
  return createFrozenFullOptionBindingRuleKernel(options, (tx, now) =>
    createPostgresFrozenFullOptionSetContentStore({
      tenantReference: tenant,
      brandReference: brand,
      actorReference: actor,
      clock: { now },
      authority,
      transactions: { run: (callback) => callback(tx) },
    }),
  );
}
/** Fixed full-intent source for supported V2 publication and independent Ack.
 * It never invokes the old User-only authority or substitutes Validate. */
export function createProductPublicationFrozenFullOptionBindingRuleSource(
  options: Omit<PublicationReaderOptions, "transactions"> & {
    readonly defaultQuantityAssessment?: "Prerequisites";
  },
) {
  const raw = copyCategoryPersistenceValue(options.command);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const command =
      (raw as Record<string, unknown>).profile ===
      "CatalogProductPublicationWarningAcknowledgementCommandV1"
        ? parseCatalogProductPublicationWarningAcknowledgementCommand(raw)
        : parseProductPublicationCommandV2(raw),
    observedAt = parseCatalogInstant(options.observedAt),
    validUntil = parseCatalogInstant(options.validUntil);
  if (
    command.occurredAt > observedAt ||
    validUntil <= observedAt ||
    Date.parse(validUntil) - Date.parse(observedAt) > 5000 ||
    typeof options.clock?.now !== "function" ||
    typeof options.authority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.registerBeforeCommit !== "function"
  )
    return fail();
  const clock = options.clock.now.bind(options.clock),
    hold = options.authority.holdUntilTransactionCompletes.bind(options.authority),
    register = options.registerBeforeCommit.bind(options);
  return createFrozenFullOptionBindingRuleKernel(
    {
      tenantReference: command.tenantReference,
      brandReference: command.brandReference,
      actorReference: command.actorReference,
      clock: { now: clock },
      ...(options.defaultQuantityAssessment === undefined
        ? {}
        : { defaultQuantityAssessment: options.defaultQuantityAssessment }),
    },
    (tx, now, internalRegister) =>
      createPostgresProductPublicationFrozenFullOptionSetContentStore({
        command,
        observedAt,
        validUntil,
        clock: { now },
        authority: { holdUntilTransactionCompletes: hold },
        registerBeforeCommit: internalRegister ?? register,
        transactions: { run: (callback) => callback(tx) },
      }),
    { observedAt, validUntil, register },
  );
}
function createFrozenFullOptionBindingRuleKernel(
  options: GraphOptions,
  createReader: (
    tx: Transaction,
    now: () => string,
    internalRegister?: PublicationReaderOptions["registerBeforeCommit"],
  ) => Reader,
  held?: {
    readonly observedAt: string;
    readonly validUntil: string;
    readonly register: PublicationReaderOptions["registerBeforeCommit"];
  },
) {
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference);
  const clock = options.clock;
  if (typeof clock?.now !== "function") return fail();
  const active = new WeakSet<object>(),
    failed = new WeakSet<object>();
  const evaluate =
    options.defaultQuantityAssessment === "Prerequisites"
      ? assessCatalogFullProductOptionBindingPrerequisites
      : evaluateCatalogFullProductOptionBindingRules;
  const now = () => parseCatalogInstant(clock.now());
  return Object.freeze({
    async withPinnedAssessment<T>(
      tx: Transaction,
      value: unknown,
      work: (assessment: FrozenFullOptionBindingRuleAssessment) => Promise<T>,
    ): Promise<T> {
      let entered = false,
        transaction: Transaction | undefined,
        ready = false,
        guardCalls = 0,
        collecting = true,
        asyncComplete = false,
        finalCalls = 0;
      const readerGuards: { readonly guard: () => Promise<void>; readonly final: () => void }[] =
        [];
      const poison = (): never => {
        if (transaction) failed.add(transaction);
        return fail();
      };
      try {
        if (held) {
          if (
            !tx ||
            typeof tx !== "object" ||
            typeof tx.query !== "function" ||
            typeof work !== "function"
          )
            return poison();
          transaction = tx;
          if (active.has(tx) || failed.has(tx)) return poison();
          active.add(tx);
          entered = true;
        }
        const observedAt = held?.observedAt ?? now(),
          query = tx.query;
        let deadline = held ? Date.parse(held.validUntil) : Date.parse(observedAt) + 30000,
          latest = observedAt;
        const check = () => {
          const at = now();
          if (
            at < latest ||
            Date.parse(at) >= deadline ||
            (held && (failed.has(tx) || tx.query !== query))
          )
            return poison();
          if (held) latest = at;
          return at;
        };
        const collect: PublicationReaderOptions["registerBeforeCommit"] = async (
          actual,
          guard,
          final,
        ) => {
          if (
            actual !== tx ||
            !collecting ||
            guardCalls !== 0 ||
            typeof guard !== "function" ||
            typeof final !== "function" ||
            readerGuards.length >= 64
          )
            return poison();
          check();
          readerGuards.push(Object.freeze({ guard, final }));
        };
        if (
          held &&
          (await held.register(
            tx,
            async () => {
              try {
                collecting = false;
                if (++guardCalls !== 1 || !ready) return poison();
                check();
                // One host slot retains every pin's independent authority/digest hold.
                for (const g of readerGuards) {
                  check();
                  if ((await g.guard()) !== undefined) return poison();
                  check();
                }
                asyncComplete = true;
              } catch (error) {
                failed.add(tx);
                throw error;
              }
            },
            () => {
              try {
                if (++finalCalls !== 1 || !ready || guardCalls !== 1 || !asyncComplete)
                  return poison();
                check();
                // The host invokes this only after ALL global asynchronous guards.
                for (const g of readerGuards) {
                  if (g.final() !== undefined) return poison();
                  check();
                }
              } catch (error) {
                failed.add(tx);
                throw error;
              }
            },
          )) !== undefined
        )
          return poison();
        check();
        // Proposed Binding only. No client graph, currentness, lease or Ready flags.
        const binding = parseProductOptionBinding(copyCategoryPersistenceValue(value));
        const reader = createReader(tx, held ? check : now, held ? collect : undefined);
        const observations = new Map<string, Observation>();
        const key = (set: string, version: string) => set + ":" + version;
        const pending = [
          {
            optionSetReference: binding.optionSetReference as string,
            versionReference: binding.optionSetVersionReference as string,
          },
        ];
        const accept = (observation: Observation, set: string, version: string) => {
          const s = observation.content.supportedContent,
            at = parseCatalogInstant(observation.observedAt),
            until = parseCatalogInstant(observation.validUntil);
          if (
            s.tenantReference !== tenant ||
            s.brandReference !== brand ||
            s.optionSetReference !== set ||
            s.versionReference !== version ||
            observation.eligibility !== "NotEvaluated" ||
            at < observedAt ||
            until <= at ||
            Date.parse(until) - Date.parse(at) > 30000
          )
            return fail();
          latest = at > latest ? at : latest;
          deadline = Math.min(deadline, Date.parse(until));
          check();
        };
        for (const pin of pending) {
          check();
          const id = key(pin.optionSetReference, pin.versionReference);
          if (observations.has(id)) continue;
          if (observations.size >= 32) return fail();
          const observation = await reader.readPinned({ ...pin, expectedRecordDigest: null });
          accept(observation, pin.optionSetReference, pin.versionReference);
          observations.set(id, observation);
          const content = observation.content.editorContent;
          for (const option of content.sourceAggregate.draft.options) {
            if (option.triggeredOptionSetReference === null) continue;
            const version = content.optionDetails.find(
              (d) => d.optionReference === option.optionReference,
            )?.triggeredOptionSetVersionReference;
            if (!version) return fail();
            const next = {
              optionSetReference: option.triggeredOptionSetReference as string,
              versionReference: version as string,
            };
            // Bound the queued unique records too, including disabled edges.
            if (
              !pending.some(
                (p) =>
                  key(p.optionSetReference, p.versionReference) ===
                  key(next.optionSetReference, next.versionReference),
              )
            ) {
              if (pending.length >= 32) return fail();
              pending.push(next);
            }
          }
        }
        const ordered = [...observations.values()].sort((a, b) =>
          key(
            a.content.supportedContent.optionSetReference,
            a.content.supportedContent.versionReference,
          ).localeCompare(
            key(
              b.content.supportedContent.optionSetReference,
              b.content.supportedContent.versionReference,
            ),
          ),
        );
        const evaluated = evaluate({
          binding,
          graph: {
            brandReference: brand,
            rootOptionSetReference: binding.optionSetReference,
            rootVersionReference: binding.optionSetVersionReference,
            contents: ordered.map((o) => o.content.editorContent),
          },
        });
        const body = {
          profile: "FrozenFullOptionBindingRuleAssessmentV1" as const,
          tenantReference: tenant as string,
          brandReference: brand as string,
          bindingReference: evaluated.bindingReference,
          bindingDigest: evaluated.bindingDigest,
          rootOptionSetReference: evaluated.rootOptionSetReference,
          rootVersionReference: evaluated.rootVersionReference,
          graphDigest: evaluated.graphDigest,
          sourceRecords: Object.freeze(
            ordered.map((o) =>
              Object.freeze({
                optionSetReference: o.content.supportedContent.optionSetReference as string,
                versionReference: o.content.supportedContent.versionReference as string,
                recordDigest: o.content.digest,
                observedAt: o.observedAt,
              }),
            ),
          ),
          rules: Object.freeze({
            status: evaluated.status,
            reason: "reason" in evaluated ? evaluated.reason : null,
            searchNodes: evaluated.searchNodes,
          }),
          observedAt,
          validUntil: new Date(deadline).toISOString(),
          publishValidation: "Incomplete" as const,
          referenceEligibility: "NotEvaluated" as const,
          eligibility: "NotEvaluated" as const,
        };
        const assessment: FrozenFullOptionBindingRuleAssessment = Object.freeze({
          ...body,
          digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)),
        });
        check();
        const result = await work(assessment);
        check();
        for (const original of ordered) {
          const s = original.content.supportedContent;
          const current = await reader.readPinned({
            optionSetReference: s.optionSetReference,
            versionReference: s.versionReference,
            expectedRecordDigest: original.content.digest,
          });
          accept(current, s.optionSetReference, s.versionReference);
          if (canonicalizeRfc8785(current.content) !== canonicalizeRfc8785(original.content))
            return fail();
          if (deadline < Date.parse(assessment.validUntil)) return fail();
          check();
        }
        check();
        if (held && readerGuards.length !== ordered.length * 2) return poison();
        collecting = false;
        ready = true;
        return result;
      } catch (error) {
        if (held && transaction) failed.add(transaction);
        if (error instanceof CatalogError) throw error;
        return fail();
      } finally {
        collecting = false;
        if (entered && transaction) active.delete(transaction);
      }
    },
  });
}
