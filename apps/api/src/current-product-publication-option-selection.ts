import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  assessCatalogProductPinnedOptionSelection,
  assessCatalogProductOptionSelection,
  parseCatalogReference,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
  type CatalogProductPublicationValidationFinding,
  type CatalogProductPublicationValidationSourceEvidence,
} from "@rms/catalog";
import {
  createProductPublicationFrozenFullOptionBindingRuleSource,
  type FrozenFullOptionBindingRuleAssessment,
} from "./frozen-full-option-binding-rule-source.js";
import {
  bindPublicationQualificationInput,
  bindWarningAcknowledgementQualificationInput,
  type ProductPublicationQualificationContext,
} from "./product-publication-qualification-context.js";

import type {
  CurrentPublishedProductOptionBindingAssessment,
  CurrentPublishedProductOptionBindingPort,
} from "./merchant-product-editor-pinned-option-authority.js";
type Observation =
  FrozenFullOptionBindingRuleAssessment | CurrentPublishedProductOptionBindingAssessment;
type GraphOptions = Parameters<typeof createProductPublicationFrozenFullOptionBindingRuleSource>[0];
type Transaction = Parameters<GraphOptions["authority"]["holdUntilTransactionCompletes"]>[0];
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
export interface CurrentProductPublicationOptionSelection {
  readonly originalIntentDigest: string;
  readonly contentDigest: string;
  readonly configurationDigest: string;
  readonly check: { readonly code: "OptionSelection"; readonly outcome: "Pass" | "HardError" };
  readonly findings: readonly CatalogProductPublicationValidationFinding[];
  readonly sources: readonly CatalogProductPublicationValidationSourceEvidence[];
  readonly observedAt: string;
  readonly validUntil: string;
}
/** Actual per-Binding owning graphs for the writer's existing held Draft. The two entry
 * points retain their original actions and purposes; the context binder supplies
 * no authority of its own. Other publication checks remain independent. */
export function createCurrentProductPublicationOptionSelectionSource(options: {
  readonly transaction: Transaction;
  readonly clock: { now(): string };
  readonly authority: GraphOptions["authority"];
  readonly registerBeforeCommit: GraphOptions["registerBeforeCommit"];
  readonly currentPublished?: CurrentPublishedProductOptionBindingPort;
}) {
  if (
    typeof options.transaction?.query !== "function" ||
    typeof options.clock?.now !== "function" ||
    typeof options.authority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.registerBeforeCommit !== "function" ||
    (options.currentPublished !== undefined &&
      typeof options.currentPublished?.withBindingAssessment !== "function")
  )
    return fail();
  const tx = options.transaction,
    query = tx.query,
    now = options.clock.now.bind(options.clock),
    hold = options.authority.holdUntilTransactionCompletes.bind(options.authority),
    register = options.registerBeforeCommit.bind(options),
    currentOwner = options.currentPublished,
    currentPort = currentOwner?.withBindingAssessment,
    currentRead = currentPort?.bind(currentOwner);
  let active = false,
    failed = false;
  async function run<T>(
    bind: () => ProductPublicationQualificationContext,
    work: (assessment: CurrentProductPublicationOptionSelection) => Promise<T>,
  ): Promise<T> {
    if (active || failed) {
      failed = true;
      return fail();
    }
    active = true;
    let ready = false,
      guardCalls = 0,
      committing = false,
      guardLimit = 0,
      assertLease: (() => string) | undefined;
    const children: { guard: () => Promise<void>; finalAssert: () => void }[] = [];
    try {
      // Capture before the first await or host hook. Even a failed capture must
      // register its rejecting guard before that failure is exposed to callers.
      let captured: ProductPublicationQualificationContext | undefined, captureError: unknown;
      try {
        captured = bind();
      } catch (error) {
        failed = true;
        captureError = error;
      }
      // Register before exposing binding errors or sampling the clock, including the empty graph.
      // A caller cannot catch a failed source and commit unrelated later work.
      const outerCheck = () => {
        if (failed || !ready || !assertLease) {
          failed = true;
          return fail();
        }
        return assertLease();
      };
      if (
        (await register(
          tx,
          async () => {
            try {
              if (++guardCalls !== 1) return fail();
              committing = true;
              outerCheck();
              for (const child of children) {
                if ((await child.guard()) !== undefined) return fail();
                outerCheck();
              }
            } catch (error) {
              failed = true;
              throw error;
            }
          },
          () => {
            try {
              if (guardCalls !== 1) return fail();
              outerCheck();
              for (const child of children) {
                if (child.finalAssert() !== undefined) return fail();
                outerCheck();
              }
            } catch (error) {
              failed = true;
              throw error;
            }
          },
        )) !== undefined
      )
        return fail();
      if (!captured) throw captureError;
      const context = captured;
      if (typeof work !== "function") return fail();
      let latest = context.observedAt;
      let deadline: string = context.validUntil;
      const check = () => {
        try {
          const at = parseCatalogInstant(now());
          if (
            failed ||
            tx.query !== query ||
            at < latest ||
            at >= deadline ||
            options.currentPublished !== currentOwner ||
            currentOwner?.withBindingAssessment !== currentPort
          )
            return fail();
          latest = at;
          return at;
        } catch {
          failed = true;
          return fail();
        }
      };
      assertLease = check;
      check();
      const bindings = [...context.aggregate.draft.optionBindings].sort((a, b) =>
        a.bindingReference.localeCompare(b.bindingReference),
      );
      // One graph coordinator per actual binding, regardless of graph size.
      // Do not consume the transaction host's bounded global guard slots per pin.
      const modes = bindings.map((binding) => {
        const rule = context.aggregate.draft.editorContent?.optionRules.find(
          (item) => item.bindingReference === binding.bindingReference,
        );
        if (
          !rule ||
          (rule.versionResolution !== "Pinned" && rule.versionResolution !== "CurrentPublished")
        )
          return fail();
        return rule.versionResolution;
      });
      const hasCurrent = modes.includes("CurrentPublished");
      guardLimit = modes.filter((mode) => mode === "Pinned").length;
      const registerChild: GraphOptions["registerBeforeCommit"] = async (
        actual,
        guard,
        finalAssert,
      ) => {
        try {
          check();
          if (
            actual !== tx ||
            committing ||
            ready ||
            typeof guard !== "function" ||
            typeof finalAssert !== "function" ||
            children.length >= guardLimit
          )
            return fail();
          children.push({ guard, finalAssert });
        } catch (error) {
          failed = true;
          throw error;
        }
      };
      const graph = () =>
          createProductPublicationFrozenFullOptionBindingRuleSource({
            command: context.command,
            observedAt: context.observedAt,
            validUntil: context.validUntil,
            clock: { now: check },
            authority: { holdUntilTransactionCompletes: hold },
            registerBeforeCommit: registerChild,
            defaultQuantityAssessment: "Prerequisites",
          }),
        observations: Observation[] = [],
        calls: number[] = [];
      let workCalls = 0;
      interface Completion {
        readonly value: T;
      }
      async function acquire(index: number): Promise<Completion> {
        check();
        const binding = bindings[index];
        if (binding) {
          let completed: Completion | undefined;
          const mode = modes[index];
          const consume = async (raw: Observation) => {
            if ((calls[index] = (calls[index] ?? 0) + 1) !== 1) {
              failed = true;
              return fail();
            }
            const observation = copyCategoryPersistenceValue(raw) as Observation;
            if (
              (mode === "Pinned"
                ? observation.profile !== "FrozenFullOptionBindingRuleAssessmentV1"
                : observation.profile !== "CurrentPublishedProductOptionBindingAssessmentV1" ||
                  observation.sourceAuthority !== "CurrentPublishingReleaseAndFrozenContent") ||
              observation.tenantReference !== context.tenantReference ||
              observation.brandReference !== context.brandReference ||
              observation.bindingReference !== binding.bindingReference ||
              observation.bindingDigest !== hash(binding) ||
              observation.rootOptionSetReference !== binding.optionSetReference ||
              observation.rootVersionReference !== binding.optionSetVersionReference ||
              observation.observedAt < context.observedAt ||
              observation.observedAt > check() ||
              observation.validUntil <= observation.observedAt ||
              observation.validUntil > context.validUntil ||
              observation.eligibility !== "NotEvaluated" ||
              observation.referenceEligibility !== "NotEvaluated"
            )
              return fail();
            const { digest, ...body } = observation;
            if (hash(body) !== digest) return fail();
            if (mode === "CurrentPublished") {
              if (!observation.sourceRecords.length) return fail();
              const seen = new Set<string>();
              for (const record of observation.sourceRecords) {
                const r = readClosedRecord(record, [
                  "optionSetReference",
                  "versionReference",
                  "publicationReference",
                  "releaseRecordDigest",
                  "sealRecordDigest",
                  "approvalDisposition",
                  "recordDigest",
                  "observedAt",
                ]);
                const key =
                  parseCatalogReference(r.optionSetReference) +
                  ":" +
                  parseCatalogReference(r.versionReference);
                parseCatalogReference(r.publicationReference);
                if (
                  seen.has(key) ||
                  typeof r.releaseRecordDigest !== "string" ||
                  !/^sha256:[a-f0-9]{64}$/.test(r.releaseRecordDigest) ||
                  typeof r.sealRecordDigest !== "string" ||
                  !/^sha256:[a-f0-9]{64}$/.test(r.sealRecordDigest) ||
                  r.recordDigest !== r.sealRecordDigest ||
                  (r.approvalDisposition !== "Approved" &&
                    r.approvalDisposition !== "PolicyWaived") ||
                  parseCatalogInstant(r.observedAt) < context.observedAt ||
                  parseCatalogInstant(r.observedAt) > observation.observedAt
                )
                  return fail();
                seen.add(key);
              }
              if (!seen.has(binding.optionSetReference + ":" + binding.optionSetVersionReference))
                return fail();
            }
            deadline = [deadline, observation.validUntil].sort()[0] ?? fail();
            check();
            observations.push(observation);
            completed = await acquire(index + 1);
            return completed;
          };
          const result =
            mode === "Pinned"
              ? await graph().withPinnedAssessment(tx, binding, consume)
              : currentRead
                ? await currentRead(tx, binding, consume)
                : fail();
          check();
          if (calls[index] !== 1 || !completed || result !== completed) return fail();
          return completed;
        }
        if (++workCalls !== 1) return fail();
        const assessment = (
          hasCurrent
            ? assessCatalogProductOptionSelection
            : assessCatalogProductPinnedOptionSelection
        )({
          aggregate: context.aggregate,
          assessments: observations.map((o) => ({
            bindingReference: o.bindingReference,
            bindingDigest: o.bindingDigest,
            rootOptionSetReference: o.rootOptionSetReference,
            rootVersionReference: o.rootVersionReference,
            status: o.rules.status,
            reason: o.rules.reason,
            ...(hasCurrent
              ? {
                  versionResolution:
                    o.profile === "FrozenFullOptionBindingRuleAssessmentV1"
                      ? "Pinned"
                      : "CurrentPublished",
                  sourceAuthority:
                    o.profile === "FrozenFullOptionBindingRuleAssessmentV1"
                      ? "RecordedFrozen"
                      : o.sourceAuthority,
                }
              : {}),
          })),
        });
        // Exclude request/root/read time from semantic reference fingerprints.
        // Reconfirming unchanged warnings must not depend on a new read clock.
        const sourceFor = (
          sourceCode: "PINNED_OPTION_RULES" | "CURRENT_PUBLISHED_OPTION_RULES",
          selected: Observation[],
        ): CatalogProductPublicationValidationSourceEvidence => {
          const references = selected.map((o) => ({
            bindingReference: o.bindingReference,
            bindingDigest: o.bindingDigest,
            graphDigest: o.graphDigest,
            rules: o.rules,
            ...(o.profile === "CurrentPublishedProductOptionBindingAssessmentV1"
              ? { sourceAuthority: o.sourceAuthority }
              : {}),
            records: o.sourceRecords.map((r) => {
              if (o.profile === "CurrentPublishedProductOptionBindingAssessmentV1") {
                const facts = r as typeof r & {
                  publicationReference: string;
                  releaseRecordDigest: string;
                  sealRecordDigest: string;
                  approvalDisposition: string;
                };
                return {
                  optionSetReference: facts.optionSetReference,
                  versionReference: facts.versionReference,
                  recordDigest: facts.recordDigest,
                  publicationReference: facts.publicationReference,
                  releaseRecordDigest: facts.releaseRecordDigest,
                  sealRecordDigest: facts.sealRecordDigest,
                  approvalDisposition: facts.approvalDisposition,
                };
              }
              return {
                optionSetReference: r.optionSetReference,
                versionReference: r.versionReference,
                recordDigest: r.recordDigest,
              };
            }),
          }));
          return Object.freeze({
            sourceCode,
            sourceDigest: hash({
              originalIntentDigest: context.originalIntentDigest,
              observations: selected,
            }),
            generation: null,
            relevantReferenceDigest: hash({
              bindings: references,
              optionRules: hasCurrent
                ? context.aggregate.draft.editorContent?.optionRules.filter((r) =>
                    selected.some((o) => o.bindingReference === r.bindingReference),
                  )
                : context.aggregate.draft.editorContent?.optionRules,
            }),
            observedAt: context.observedAt,
            validUntil: deadline,
          });
        };
        const sources = hasCurrent
          ? (["PINNED_OPTION_RULES", "CURRENT_PUBLISHED_OPTION_RULES"] as const).flatMap((code) => {
              const selected = observations.filter(
                (o) =>
                  (o.profile === "FrozenFullOptionBindingRuleAssessmentV1") ===
                  (code === "PINNED_OPTION_RULES"),
              );
              return selected.length ? [sourceFor(code, selected)] : [];
            })
          : [sourceFor("PINNED_OPTION_RULES", observations)];
        const findings = Object.freeze(
          assessment.findings.map((f) =>
            Object.freeze({
              ...f,
              references: Object.freeze(
                f.references.map((reference) => {
                  const record = observations
                    .find((o) => o.bindingReference === f.subjectReference)
                    ?.sourceRecords.find(
                      (r) =>
                        r.optionSetReference === reference.resourceReference &&
                        r.versionReference === reference.versionReference,
                    );
                  if (!record) return fail();
                  return Object.freeze({ ...reference, referenceDigest: record.recordDigest });
                }),
              ),
            }),
          ),
        );
        const result = Object.freeze({
          originalIntentDigest: context.originalIntentDigest,
          contentDigest: context.contentDigest,
          configurationDigest: context.configurationDigest,
          check: assessment.check,
          findings,
          sources: Object.freeze(sources),
          observedAt: context.observedAt,
          validUntil: deadline,
        });
        check();
        const value = await work(result);
        check();
        return { value };
      }
      const completed = await acquire(0);
      check();
      if (workCalls !== 1 || calls.some((n) => n !== 1) || children.length !== guardLimit)
        return fail();
      ready = true;
      return completed.value;
    } catch (error) {
      failed = true;
      if (error instanceof CatalogError) throw error;
      return fail();
    } finally {
      active = false;
    }
  }
  return Object.freeze({
    withPublication<T>(
      input: Parameters<typeof bindPublicationQualificationInput>[0],
      originalValidUntil: string,
      work: (assessment: CurrentProductPublicationOptionSelection) => Promise<T>,
    ) {
      return run(() => bindPublicationQualificationInput(input, originalValidUntil), work);
    },
    withAcknowledgement<T>(
      input: Parameters<typeof bindWarningAcknowledgementQualificationInput>[0],
      work: (assessment: CurrentProductPublicationOptionSelection) => Promise<T>,
    ) {
      return run(() => bindWarningAcknowledgementQualificationInput(input), work);
    },
  });
}
