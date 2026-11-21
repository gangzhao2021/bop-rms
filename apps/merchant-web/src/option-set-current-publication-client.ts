import {
  parseCatalogReference as ref,
  parseCatalogInstant as instant,
  productCommandRecord as record,
} from "./catalog-product-command-values.js";
import {
  parseOptionSetAuthoringScope,
  parseOptionSetEditorContent,
  contentDigests,
  type OptionSetAuthoringScope,
  type OptionSetEditorContent,
} from "./option-set-authoring-client.js";
export class OptionSetCurrentPublicationClientError extends Error {
  constructor(
    readonly code:
      | "Invalid"
      | "Denied"
      | "FeatureDisabled"
      | "Conflict"
      | "Stale"
      | "Unavailable"
      | "ScopeChanged",
  ) {
    super("Current Option Set publication could not be loaded");
    this.name = "OptionSetCurrentPublicationClientError";
  }
}
const fail = (code: OptionSetCurrentPublicationClientError["code"] = "Invalid"): never => {
  throw new OptionSetCurrentPublicationClientError(code);
};
const integer = (v: unknown, min = 1, max = 2147483647): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) return fail();
  return v;
};
const digest = (v: unknown): string => {
  if (typeof v !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(v)) return fail();
  return v;
};
function choice<T extends string>(v: unknown, values: readonly T[]): T {
  if (typeof v !== "string" || !values.includes(v as T)) return fail();
  return v as T;
}
function lease(value: Record<string, unknown>, now: string) {
  const observedAt = instant(value.observedAt),
    validUntil = instant(value.validUntil);
  if (
    observedAt > now ||
    validUntil <= now ||
    validUntil <= observedAt ||
    Date.parse(validUntil) - Date.parse(observedAt) > 5000
  )
    return fail("Stale");
  return { observedAt, validUntil };
}
export interface OptionSetCurrentPublicationRequest {
  readonly optionSetReference: string;
  readonly expectedAggregateVersion: number | null;
}
export interface OptionSetCurrentPublicationRelease {
  readonly publicationReference: string;
  readonly releaseSequence: number;
  readonly releasedAt: string;
  readonly lifecycleReference: string;
  readonly lifecycleVersion: number;
  readonly snapshotReference: string;
  readonly snapshotDigest: string;
  readonly approvalDisposition: "Approved" | "PolicyWaived";
}
export interface OptionSetCurrentPublicationSourceRecord {
  readonly optionSetReference: string;
  readonly versionReference: string;
  readonly publicationReference: string;
  readonly releaseRecordDigest: string;
  readonly sealRecordDigest: string;
  readonly approvalDisposition: "Approved" | "PolicyWaived";
}
export interface OptionSetCurrentPublishedContent {
  readonly profile: "CatalogOptionSetCurrentPublishedContentV1";
  readonly content: OptionSetEditorContent;
  readonly sourceDigest: string;
  readonly contentDigest: string;
  readonly configurationDigest: string;
  readonly sourceRecords: readonly OptionSetCurrentPublicationSourceRecord[];
  readonly graphDigest: string;
  readonly rules: Readonly<{
    status: "Satisfiable" | "Unsatisfiable" | "Indeterminate";
    reason: string | null;
    searchNodes: number;
  }>;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly sourceAuthority: "CurrentPublishingReleaseAndFrozenContent";
  readonly referenceEligibility: "NotEvaluated";
  readonly eligibility: "NotEvaluated";
  readonly publishValidation: "Incomplete";
}
export interface OptionSetCurrentPublicationView {
  readonly profile: "CatalogOptionSetCurrentPublicationResultV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly optionSetReference: string;
  readonly currentAggregateVersion: number;
  readonly publicationState: "Absent" | "NotCurrentlyPublished" | "Published";
  readonly currentLifecycleReference: string | null;
  readonly lastReleaseReference: string | null;
  readonly release: OptionSetCurrentPublicationRelease | null;
  readonly published: OptionSetCurrentPublishedContent | null;
  readonly observedAt: string;
  readonly validUntil: string;
}
export function parseOptionSetCurrentPublicationRequest(
  value: unknown,
): OptionSetCurrentPublicationRequest {
  const r = record(value, ["optionSetReference", "expectedAggregateVersion"]);
  return Object.freeze({
    optionSetReference: ref(r.optionSetReference),
    expectedAggregateVersion:
      r.expectedAggregateVersion === null ? null : integer(r.expectedAggregateVersion),
  });
}
export async function parseOptionSetCurrentPublicationView(
  value: unknown,
  requestValue: unknown,
  expectedScope: unknown,
  now = new Date().toISOString(),
): Promise<OptionSetCurrentPublicationView> {
  try {
    const request = parseOptionSetCurrentPublicationRequest(requestValue),
      expected = parseOptionSetAuthoringScope(expectedScope),
      r = record(value, [
        "profile",
        "tenantReference",
        "brandReference",
        "storeReference",
        "actorReference",
        "optionSetReference",
        "currentAggregateVersion",
        "publicationState",
        "currentLifecycleReference",
        "lastReleaseReference",
        "release",
        "published",
        "observedAt",
        "validUntil",
      ]);
    if (
      r.tenantReference !== expected.tenantReference ||
      r.brandReference !== expected.brandReference ||
      r.storeReference !== expected.storeReference ||
      r.actorReference !== expected.actorReference
    )
      return fail("ScopeChanged");
    const currentAggregateVersion = integer(r.currentAggregateVersion),
      publicationState = choice(r.publicationState, [
        "Absent",
        "NotCurrentlyPublished",
        "Published",
      ]),
      currentLifecycleReference =
        r.currentLifecycleReference === null ? null : ref(r.currentLifecycleReference),
      lastReleaseReference = r.lastReleaseReference === null ? null : ref(r.lastReleaseReference),
      held = lease(r, instant(now));
    if (
      r.profile !== "CatalogOptionSetCurrentPublicationResultV1" ||
      r.optionSetReference !== request.optionSetReference ||
      (request.expectedAggregateVersion !== null &&
        request.expectedAggregateVersion !== currentAggregateVersion)
    )
      return fail();
    let release: OptionSetCurrentPublicationRelease | null = null,
      published: OptionSetCurrentPublishedContent | null = null;
    if (publicationState !== "Published") {
      if (
        r.release !== null ||
        r.published !== null ||
        (publicationState === "Absent"
          ? lastReleaseReference !== null
          : currentLifecycleReference === null || lastReleaseReference === null)
      )
        return fail();
    } else {
      const rel = record(r.release, [
        "publicationReference",
        "releaseSequence",
        "releasedAt",
        "lifecycleReference",
        "lifecycleVersion",
        "snapshotReference",
        "snapshotDigest",
        "approvalDisposition",
      ]);
      release = Object.freeze({
        publicationReference: ref(rel.publicationReference),
        releaseSequence: integer(rel.releaseSequence),
        releasedAt: instant(rel.releasedAt),
        lifecycleReference: ref(rel.lifecycleReference),
        lifecycleVersion: integer(rel.lifecycleVersion),
        snapshotReference: ref(rel.snapshotReference),
        snapshotDigest: digest(rel.snapshotDigest),
        approvalDisposition: choice(rel.approvalDisposition, ["Approved", "PolicyWaived"]),
      });
      if (
        currentLifecycleReference !== release.lifecycleReference ||
        lastReleaseReference !== release.publicationReference ||
        release.releasedAt > held.observedAt
      )
        return fail();
      const p = record(r.published, [
          "profile",
          "content",
          "sourceDigest",
          "contentDigest",
          "configurationDigest",
          "sourceRecords",
          "graphDigest",
          "rules",
          "observedAt",
          "validUntil",
          "sourceAuthority",
          "referenceEligibility",
          "eligibility",
          "publishValidation",
        ]),
        content = parseOptionSetEditorContent(p.content),
        a = content.sourceAggregate,
        hashes = await contentDigests(content),
        sourceLease = lease(p, instant(now));
      if (
        p.profile !== "CatalogOptionSetCurrentPublishedContentV1" ||
        p.sourceAuthority !== "CurrentPublishingReleaseAndFrozenContent" ||
        p.referenceEligibility !== "NotEvaluated" ||
        p.eligibility !== "NotEvaluated" ||
        p.publishValidation !== "Incomplete" ||
        a.optionSetReference !== request.optionSetReference ||
        a.brandReference !== expected.brandReference ||
        a.draft.versionReference !== release.snapshotReference ||
        a.aggregateVersion >= currentAggregateVersion ||
        a.updatedAt > release.releasedAt ||
        sourceLease.validUntil < held.validUntil ||
        p.sourceDigest !== hashes.sourceDigest ||
        p.contentDigest !== hashes.contentDigest ||
        p.configurationDigest !== hashes.configurationDigest
      )
        return fail();
      if (
        !Array.isArray(p.sourceRecords) ||
        Object.getPrototypeOf(p.sourceRecords) !== Array.prototype ||
        p.sourceRecords.length < 1 ||
        p.sourceRecords.length > 32 ||
        Reflect.ownKeys(p.sourceRecords).length !== p.sourceRecords.length + 1
      )
        return fail();
      const sourceRecords = Object.freeze(
        Array.from({ length: p.sourceRecords.length }, (_, i) => {
          const descriptor = Object.getOwnPropertyDescriptor(p.sourceRecords, String(i));
          if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
          const s = record(descriptor.value, [
            "optionSetReference",
            "versionReference",
            "publicationReference",
            "releaseRecordDigest",
            "sealRecordDigest",
            "approvalDisposition",
          ]);
          return Object.freeze({
            optionSetReference: ref(s.optionSetReference),
            versionReference: ref(s.versionReference),
            publicationReference: ref(s.publicationReference),
            releaseRecordDigest: digest(s.releaseRecordDigest),
            sealRecordDigest: digest(s.sealRecordDigest),
            approvalDisposition: choice(s.approvalDisposition, ["Approved", "PolicyWaived"]),
          });
        }),
      );
      if (new Set(sourceRecords.map((s) => s.optionSetReference)).size !== sourceRecords.length)
        return fail();
      const root = sourceRecords.find((s) => s.optionSetReference === request.optionSetReference);
      if (
        !root ||
        root.versionReference !== release.snapshotReference ||
        root.publicationReference !== release.publicationReference ||
        root.approvalDisposition !== release.approvalDisposition
      )
        return fail();
      for (const option of a.draft.options) {
        if (option.triggeredOptionSetReference !== null) {
          const detail = content.optionDetails.find(
              (d) => d.optionReference === option.optionReference,
            ),
            child = sourceRecords.find(
              (s) => s.optionSetReference === option.triggeredOptionSetReference,
            );
          if (
            !detail ||
            !child ||
            detail.triggeredOptionSetVersionReference !== child.versionReference
          )
            return fail();
        }
      }
      const rule = record(p.rules, ["status", "reason", "searchNodes"]),
        status = choice(rule.status, ["Satisfiable", "Unsatisfiable", "Indeterminate"]),
        reason =
          rule.reason === null
            ? null
            : choice(rule.reason, [
                "TriggerCycle",
                "NoSelection",
                "ComplexityLimit",
                "SearchLimit",
              ]);
      if (
        status === "Satisfiable"
          ? reason !== null
          : status === "Unsatisfiable"
            ? !["TriggerCycle", "NoSelection"].includes(reason ?? "")
            : !["ComplexityLimit", "SearchLimit"].includes(reason ?? "")
      )
        return fail();
      published = Object.freeze({
        profile: "CatalogOptionSetCurrentPublishedContentV1",
        content,
        ...hashes,
        sourceRecords,
        graphDigest: digest(p.graphDigest),
        rules: Object.freeze({ status, reason, searchNodes: integer(rule.searchNodes, 0) }),
        ...sourceLease,
        sourceAuthority: "CurrentPublishingReleaseAndFrozenContent",
        referenceEligibility: "NotEvaluated",
        eligibility: "NotEvaluated",
        publishValidation: "Incomplete",
      });
    }
    return Object.freeze({
      profile: "CatalogOptionSetCurrentPublicationResultV1",
      ...expected,
      optionSetReference: request.optionSetReference,
      currentAggregateVersion,
      publicationState,
      currentLifecycleReference,
      lastReleaseReference,
      release,
      published,
      ...held,
    });
  } catch (error) {
    if (error instanceof OptionSetCurrentPublicationClientError) throw error;
    return fail();
  }
}
export function createOptionSetCurrentPublicationClient(fetcher: typeof fetch = globalThis.fetch) {
  if (typeof fetcher !== "function") return fail();
  const transport = fetcher.bind(globalThis);
  return Object.freeze({
    async load(input: {
      readonly command: unknown;
      readonly expectedScope: OptionSetAuthoringScope;
      readonly csrf: string;
      readonly signal?: AbortSignal;
    }): Promise<OptionSetCurrentPublicationView> {
      let command: OptionSetCurrentPublicationRequest, scope: OptionSetAuthoringScope;
      try {
        command = parseOptionSetCurrentPublicationRequest(input.command);
        scope = parseOptionSetAuthoringScope(input.expectedScope);
        if (typeof input.csrf !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(input.csrf))
          return fail();
      } catch (error) {
        if (error instanceof OptionSetCurrentPublicationClientError) throw error;
        return fail();
      }
      if (input.signal?.aborted) return fail("Unavailable");
      const controller = new AbortController();
      let rejectAbort: ((reason: unknown) => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
          rejectAbort = reject;
        }),
        abort = () => {
          controller.abort();
          rejectAbort?.(new OptionSetCurrentPublicationClientError("Unavailable"));
        };
      input.signal?.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(abort, 15000);
      try {
        const response = await Promise.race([
          transport("/merchant/catalog/option-sets/current-published", {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
            signal: controller.signal,
            body: JSON.stringify(command),
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "X-BOP-CSRF": input.csrf,
              "X-BOP-Catalog-Scope": btoa(
                JSON.stringify({
                  brandReference: scope.brandReference,
                  storeReference: scope.storeReference,
                }),
              )
                .replace(/\+/gu, "-")
                .replace(/\//gu, "_")
                .replace(/=+$/u, ""),
            },
          }),
          aborted,
        ]);
        if (
          controller.signal.aborted ||
          response.headers.get("cache-control") !== "no-store" ||
          !/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "") ||
          !response.body
        )
          return fail("Unavailable");
        const reader = response.body.getReader(),
          decoder = new TextDecoder("utf-8", { fatal: true });
        let bytes = 0,
          text = "";
        try {
          while (true) {
            const chunk = await Promise.race([reader.read(), aborted]);
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 2097152) return fail("Unavailable");
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          void reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
        if (controller.signal.aborted) return fail("Unavailable");
        const value: unknown = JSON.parse(text);
        if (response.status !== 200) {
          const error = record(value, ["error"]).error;
          if ((response.status === 401 || response.status === 403) && error === "request_denied")
            return fail("Denied");
          if (
            (response.status === 400 || response.status === 413) &&
            error === "option_set_current_publication_invalid"
          )
            return fail("Invalid");
          if (
            response.status === 409 &&
            error === "option_set_current_publication_feature_disabled"
          )
            return fail("FeatureDisabled");
          if (response.status === 409 && error === "option_set_current_publication_conflict")
            return fail("Conflict");
          return fail("Unavailable");
        }
        const view = await parseOptionSetCurrentPublicationView(value, command, scope);
        if (controller.signal.aborted) return fail("Unavailable");
        lease({ ...view }, new Date().toISOString());
        return view;
      } catch (error) {
        if (error instanceof OptionSetCurrentPublicationClientError) throw error;
        return fail("Unavailable");
      } finally {
        clearTimeout(timeout);
        input.signal?.removeEventListener("abort", abort);
      }
    },
  });
}
