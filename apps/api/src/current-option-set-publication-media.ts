import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  createMediaScope,
  createPostgresMediaOptionSetPublicationReadSource,
  mediaPublicationReadFields,
  parseMediaOptionSetPublicationReadRequest,
  parseMediaOptionSetPublicationReadSnapshot,
  type MediaOptionSetPublicationReadSnapshot,
} from "@bop/media";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  evaluateCatalogOptionSetRuleSatisfiability,
  parseCatalogInstant,
  parseCatalogReference,
  parseCatalogOptionSetContentPolicyBinding,
  parseCatalogOptionSetEditorContent,
} from "@rms/catalog";
import { parseBusinessAction, parsePolicyReference, parsePolicyVersion } from "@bop/permission";
import type { CurrentPublishedOptionSetGraphOptions } from "./current-published-option-set-graph.js";
import type { createCurrentOptionSetPublicationDraftGraphSource } from "./current-option-set-publication-draft-graph.js";
import { MerchantProductWriteFeatureDisabled } from "./merchant-product-write-authority.js";

type Graph = Parameters<
  Parameters<
    ReturnType<typeof createCurrentOptionSetPublicationDraftGraphSource>["withCurrentGraph"]
  >[1]
>[0];
type MediaOptions = Parameters<typeof createPostgresMediaOptionSetPublicationReadSource>[0];
export interface CurrentOptionSetPublicationMediaOptions extends CurrentPublishedOptionSetGraphOptions {
  readonly operationReference: string;
  /** Server-selected owning Media scope. No caller-selected scope or sharing proof. */
  readonly mediaScope: MediaOptions["scope"];
}
export interface CurrentOptionSetPublicationMedia {
  readonly profile: "CurrentOptionSetPublicationMediaV1";
  readonly binding: ReturnType<typeof parseCatalogOptionSetContentPolicyBinding>;
  readonly operationReference: string;
  readonly graphDigest: string;
  readonly nodes: readonly {
    readonly optionSetReference: string;
    readonly versionReference: string;
    readonly coverage: "NoReferences" | "AllRecordedPins";
    readonly snapshot: MediaOptionSetPublicationReadSnapshot;
    readonly check: { readonly code: "MediaReady"; readonly outcome: "Pass" | "HardError" };
    readonly findings: readonly {
      readonly mediaReference: string;
      readonly reason: "NotFound" | "NotReady" | "UnsupportedMedia" | "UnsupportedAdjustment";
    }[];
  }[];
  readonly originalObservedAt: string;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly eligibility: "NotEvaluated";
  readonly deliveryEligibility: "NotEvaluated";
  readonly publishValidation: "Incomplete";
  readonly sourceAuthority: "CurrentOwningPinnedMediaReadiness";
  readonly digest: string;
}
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
/** Invoke only inside the genuine held publication graph callback. This adapter
 * binds all recorded media, including unselected choices; supplied graph data
 * alone is never a graph authorization proof. Asset delivery is independent. */
export function createCurrentOptionSetPublicationMediaSource(
  options: CurrentOptionSetPublicationMediaOptions,
) {
  const tx = options.transaction,
    query = tx?.query,
    tenant = String(parseCatalogReference(options.tenantReference)),
    brand = String(parseCatalogReference(options.brandReference)),
    store = String(parseCatalogReference(options.storeReference)),
    actor = String(parseCatalogReference(options.actorReference)),
    session = String(parseCatalogReference(options.sessionReference)),
    operation = String(parseCatalogReference(options.operationReference)),
    scope = createMediaScope(options.mediaScope);
  if (
    scope.brandReference !== brand ||
    (scope.kind === "Store" && scope.storeReference !== store) ||
    typeof query !== "function" ||
    typeof options.clock?.now !== "function" ||
    typeof options.currentAuthorization?.authorizeActions !== "function" ||
    typeof options.currentAuthorization?.authorizeActionsWithDecisions !== "function" ||
    typeof options.currentAuthorization?.assertCurrent !== "function" ||
    typeof options.currentAuthorization?.leaseDeadline !== "function" ||
    typeof options.capability?.holdUntilCommit !== "function" ||
    (options.capability.holdUntilCommitWithDecisions !== undefined &&
      typeof options.capability.holdUntilCommitWithDecisions !== "function") ||
    typeof options.capability?.leaseDeadline !== "function" ||
    typeof options.registerBeforeCommit !== "function"
  )
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  const clockPort = options.clock.now,
    clock = clockPort.bind(options.clock),
    authPort = options.currentAuthorization.authorizeActions,
    decisionPort = options.currentAuthorization.authorizeActionsWithDecisions,
    decisions = decisionPort.bind(options.currentAuthorization),
    assertPort = options.currentAuthorization.assertCurrent,
    assertCurrent = assertPort.bind(options.currentAuthorization),
    leasePort = options.currentAuthorization.leaseDeadline,
    lease = leasePort.bind(options.currentAuthorization),
    combinedPort = options.capability.holdUntilCommitWithDecisions,
    combined =
      typeof combinedPort === "function" ? combinedPort.bind(options.capability) : undefined,
    capPort = options.capability.holdUntilCommit,
    capability = capPort.bind(options.capability),
    capLeasePort = options.capability.leaseDeadline,
    capLease = capLeasePort.bind(options.capability),
    registerPort = options.registerBeforeCommit,
    register = registerPort.bind(options);
  const startedAt = parseCatalogInstant(clock()),
    originalDeadline = parseCatalogInstant(options.originalValidUntil);
  if (originalDeadline <= startedAt || Date.parse(originalDeadline) - Date.parse(startedAt) > 5000)
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  let deadline: string = originalDeadline,
    latest: string = startedAt,
    failed = false,
    entered = false,
    active = false,
    ready = false,
    guards = 0,
    complete = false,
    finals = 0;
  const fail = (): never => {
    failed = true;
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  };
  const reject = (error: unknown): never => {
    failed = true;
    if (error instanceof CatalogError || error instanceof MerchantProductWriteFeatureDisabled)
      throw error;
    return fail();
  };
  const check = () => {
    try {
      const at = parseCatalogInstant(clock());
      if (
        failed ||
        tx.query !== query ||
        at < latest ||
        at >= deadline ||
        options.clock.now !== clockPort ||
        options.currentAuthorization.authorizeActions !== authPort ||
        options.currentAuthorization.authorizeActionsWithDecisions !== decisionPort ||
        options.currentAuthorization.assertCurrent !== assertPort ||
        options.currentAuthorization.leaseDeadline !== leasePort ||
        options.capability.holdUntilCommit !== capPort ||
        options.capability.holdUntilCommitWithDecisions !== combinedPort ||
        options.capability.leaseDeadline !== capLeasePort ||
        options.registerBeforeCommit !== registerPort ||
        options.tenantReference !== tenant ||
        options.brandReference !== brand ||
        options.storeReference !== store ||
        options.actorReference !== actor ||
        options.sessionReference !== session ||
        options.operationReference !== operation ||
        !equal(options.mediaScope, scope)
      )
        return fail();
      assertCurrent();
      latest = at;
      return at;
    } catch (error) {
      return reject(error);
    }
  };
  const tighten = () => {
    for (const value of [lease(), capLease()]) {
      const until = parseCatalogInstant(value);
      if (until < deadline) deadline = until;
    }
    check();
  };
  const hold = async () => {
    check();
    const actions = Object.freeze([
      "catalog.manage",
      "catalog.option_set.read",
      "media.asset.access",
    ]);
    let evidence;
    if (combined) evidence = await combined(actions);
    else {
      if ((await capability()) !== undefined) return fail();
      check();
      evidence = await decisions(actions);
    }
    check();
    if (combined) {
      if (
        !Array.isArray(evidence) ||
        Object.getPrototypeOf(evidence) !== Array.prototype ||
        evidence.length !== actions.length
      )
        return fail();
      const descriptors = Object.getOwnPropertyDescriptors(evidence);
      if (
        Reflect.ownKeys(evidence).length !== actions.length + 1 ||
        actions.some((_, i) => {
          const d = descriptors[String(i)];
          return !d || !d.enumerable || !("value" in d);
        })
      )
        return fail();

      for (let i = 0; i < evidence.length; i++) {
        const row = readClosedRecord(evidence[i], [
            "effect",
            "reason",
            "source",
            "action",
            "scopeKind",
            "policySnapshotReference",
            "policyVersion",
            "audit",
          ]),
          audit = readClosedRecord(row.audit, ["effect", "reason", "source"]);
        if (
          row.effect !== "Allow" ||
          row.scopeKind !== "Brand" ||
          row.action !== actions[i] ||
          parseBusinessAction(row.action) !== actions[i] ||
          (row.reason !== "EXPLICIT_ALLOW" && row.reason !== "ROLE_PERMISSION") ||
          (row.source !== "ExplicitAllow" && row.source !== "RolePermission") ||
          (row.reason === "EXPLICIT_ALLOW") !== (row.source === "ExplicitAllow") ||
          audit.effect !== row.effect ||
          audit.reason !== row.reason ||
          audit.source !== row.source
        )
          return fail();
        parsePolicyReference(row.policySnapshotReference);
        parsePolicyVersion(row.policyVersion);
      }
    } else {
      if (
        !Array.isArray(evidence) ||
        evidence.length !== actions.length ||
        evidence.some(
          (d, i) => d.effect !== "Allow" || d.action !== actions[i] || d.scopeKind !== "Brand",
        )
      )
        return fail();
    }
    tighten();
  };
  return Object.freeze({
    async withCurrentAssessment<T>(
      input: { readonly graph: Graph; readonly binding: unknown },
      work: (source: CurrentOptionSetPublicationMedia) => Promise<T>,
    ): Promise<T> {
      if (entered) return fail();
      entered = true;
      active = true;
      try {
        if (
          (await register(
            tx,
            async () => {
              if (!ready || active || ++guards !== 1) return fail();
              try {
                await hold();
                check();
                complete = true;
              } catch (error) {
                return reject(error);
              }
            },
            () => {
              if (!ready || active || !complete || guards !== 1 || ++finals !== 1) return fail();
              check();
            },
          )) !== undefined
        )
          return fail();
        const copied = copyCategoryPersistenceValue(input);
        if (
          !copied ||
          typeof copied !== "object" ||
          Array.isArray(copied) ||
          Object.keys(copied).length !== 2 ||
          !Object.hasOwn(copied, "graph") ||
          !Object.hasOwn(copied, "binding")
        )
          return fail();
        const packet = copied as Record<string, unknown>;
        const binding = parseCatalogOptionSetContentPolicyBinding(packet.binding),
          graph = packet.graph as Graph;
        if (
          typeof work !== "function" ||
          graph.profile !== "CurrentOptionSetPublicationDraftGraphV1" ||
          graph.sourceAuthority !== "CurrentDraftRootAndCurrentPublishedChildren" ||
          graph.eligibility !== "NotEvaluated" ||
          graph.referenceEligibility !== "NotEvaluated" ||
          graph.publishValidation !== "Incomplete" ||
          binding.tenantReference !== tenant ||
          binding.brandReference !== brand ||
          graph.graph.brandReference !== brand ||
          graph.graph.rootOptionSetReference !== binding.optionSetReference ||
          graph.graph.rootVersionReference !== binding.versionReference ||
          graph.aggregateVersion !== binding.expectedAggregateVersion ||
          graph.sourceDigest !== binding.sourceDigest ||
          graph.contentDigest !== binding.contentDigest ||
          graph.configurationDigest !== binding.configurationDigest ||
          graph.graphDigest !== binding.graphDigest ||
          graph.originalObservedAt > check() ||
          binding.observedAt < graph.originalObservedAt ||
          binding.observedAt > check() ||
          graph.graph.contents.length < 1 ||
          graph.graph.contents.length > 32
        )
          return fail();
        const rule = evaluateCatalogOptionSetRuleSatisfiability(graph.graph);
        if (
          rule.graphDigest !== binding.graphDigest ||
          ("reason" in rule &&
            ["IncompleteTriggerGraph", "AmbiguousTriggerVersion"].includes(rule.reason ?? ""))
        )
          return fail();
        for (const value of [graph.validUntil, binding.validUntil]) {
          const until = parseCatalogInstant(value);
          if (until < deadline) deadline = until;
        }
        check();
        const nodes = graph.graph.contents.map((content) => {
          const { sourceAggregate, profile, ...details } = content;
          const parsed = parseCatalogOptionSetEditorContent(sourceAggregate, {
            profile,
            ...details,
          });
          if (parsed.content.sourceAggregate.brandReference !== brand) return fail();
          return parsed;
        });
        if (
          new Set(nodes.map((n) => n.content.sourceAggregate.optionSetReference)).size !==
          nodes.length
        )
          return fail();
        const root = nodes.find(
          (n) => n.content.sourceAggregate.optionSetReference === binding.optionSetReference,
        );
        if (
          !root ||
          root.sourceDigest !== binding.sourceDigest ||
          root.contentDigest !== binding.contentDigest ||
          root.configurationDigest !== binding.configurationDigest ||
          !equal(graph.sourceSnapshotTuple, {
            tenantReference: tenant,
            brandReference: brand,
            optionSetReference: binding.optionSetReference,
            versionReference: binding.versionReference,
            aggregateVersion: binding.expectedAggregateVersion,
            sourceDigest: binding.sourceDigest,
            contentDigest: binding.contentDigest,
            configurationDigest: binding.configurationDigest,
          })
        )
          return fail();
        await hold();
        const evidence: CurrentOptionSetPublicationMedia["nodes"][number][] = [];
        const visit = async (index: number): Promise<T> => {
          const node = nodes[index];
          if (index === nodes.length) {
            const body = {
              profile: "CurrentOptionSetPublicationMediaV1" as const,
              binding,
              operationReference: operation,
              graphDigest: graph.graphDigest,
              nodes: Object.freeze(evidence),
              originalObservedAt: startedAt,
              observedAt: check(),
              validUntil: deadline,
              eligibility: "NotEvaluated" as const,
              deliveryEligibility: "NotEvaluated" as const,
              publishValidation: "Incomplete" as const,
              sourceAuthority: "CurrentOwningPinnedMediaReadiness" as const,
            };
            const result = await work(Object.freeze({ ...body, digest: hash(body) }));
            check();
            await hold();
            return result;
          }
          if (!node) return fail();
          const recorded = node.content.optionDetails.flatMap((d) =>
            d.media === null
              ? []
              : [
                  {
                    mediaReference: d.media.mediaReference,
                    assetReference: d.media.assetReference,
                    assetVersionReference: d.media.assetVersionReference,
                    cropReference: null,
                    focusReference: null,
                  },
                ],
          );
          const pins = new Map<string, (typeof recorded)[number]>();
          for (const pin of recorded) {
            const previous = pins.get(pin.mediaReference);
            if (previous && !equal(previous, pin)) return fail();
            pins.set(pin.mediaReference, pin);
          }
          const references = [...pins.values()];
          if (references.length > 100) return fail();
          const request = parseMediaOptionSetPublicationReadRequest({
            profile: "MediaOptionSetPublicationReadRequestV1",
            tenantReference: tenant,
            scope,
            actorReference: actor,
            actorKind: "User",
            operationReference: operation,
            originalIntentDigest: binding.originalIntentDigest,
            optionSetReference: node.content.sourceAggregate.optionSetReference,
            versionReference: node.content.sourceAggregate.draft.versionReference,
            expectedAggregateVersion: node.content.sourceAggregate.aggregateVersion,
            sourceDigest: node.sourceDigest,
            contentDigest: node.contentDigest,
            configurationDigest: node.configurationDigest,
            graphDigest: binding.graphDigest,
            activationAt: binding.activationAt,
            references,
            observedAt: binding.observedAt,
            validUntil: deadline,
          });
          const owner = createPostgresMediaOptionSetPublicationReadSource({
            tenantReference: tenant,
            scope,
            actorReference: actor,
            actorKind: "User",
            clock: { now: check },
            registerBeforeCommit: async (actual, guard, final) => {
              if (actual !== tx) return fail();
              if ((await register(tx, guard, final)) !== undefined) return fail();
            },
            authority: {
              async holdUntilTransactionCompletes(actual, packet) {
                if (
                  actual !== tx ||
                  packet.action !== "media.asset.access" ||
                  packet.purposeCode !== "CATALOG_OPTION_SET_PUBLICATION_MEDIA_READ" ||
                  !equal(packet.requiredFields, mediaPublicationReadFields) ||
                  !equal(parseMediaOptionSetPublicationReadRequest(packet.request), request)
                )
                  return fail();
                await hold();
                return { observedAt: request.observedAt, validUntil: deadline };
              },
            },
          });
          let calls = 0;
          const result = await owner.withCurrentReferences(tx, request, async (value, actual) => {
            if (++calls !== 1 || actual !== tx) return fail();
            const snapshot = parseMediaOptionSetPublicationReadSnapshot(value);
            if (
              !equal(snapshot.request, request) ||
              snapshot.observedAt > check() ||
              snapshot.validUntil > deadline
            )
              return fail();
            deadline = snapshot.validUntil;
            check();
            const findings = snapshot.references.flatMap((r) =>
              r.status === "Ready"
                ? []
                : [Object.freeze({ mediaReference: r.mediaReference, reason: r.reason })],
            );
            evidence.push(
              Object.freeze({
                optionSetReference: String(node.content.sourceAggregate.optionSetReference),
                versionReference: String(node.content.sourceAggregate.draft.versionReference),
                coverage: references.length ? "AllRecordedPins" : "NoReferences",
                snapshot,
                check: Object.freeze({
                  code: "MediaReady",
                  outcome: findings.length ? "HardError" : "Pass",
                }),
                findings: Object.freeze(findings),
              }),
            );
            return visit(index + 1);
          });
          if (calls !== 1) return fail();
          check();
          return result;
        };
        const result = await visit(0);
        active = false;
        ready = true;
        check();
        return result;
      } catch (error) {
        return reject(error);
      } finally {
        active = false;
      }
    },
  });
}
