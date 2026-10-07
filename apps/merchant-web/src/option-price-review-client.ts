import {
  copyProductCommandValue as copy,
  productCommandRecord as record,
  parseCatalogReference as ref,
  parseCatalogInstant as instant,
} from "./catalog-product-command-values.js";
import { canonicalPublicationValue as canonical } from "./product-publication-command-client-v2.js";
import { parseOptionSetAuthoringScope } from "./option-set-authoring-client.js";
import type {
  OptionPriceAuthoringScope,
  OptionPriceAuthoringClientCode,
  OptionPriceRequestControl,
} from "./option-price-authoring-client.js";
export class OptionPriceReviewClientError extends Error {
  constructor(
    readonly code: OptionPriceAuthoringClientCode,
    readonly attemptCode?: OptionPriceAuthoringClientCode,
  ) {
    super("Option price review could not be confirmed");
    this.name = "OptionPriceReviewClientError";
  }
}
const fail = (code: OptionPriceAuthoringClientCode = "Invalid"): never => {
  throw new OptionPriceReviewClientError(code);
};
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function safe<T>(work: () => T): T {
  try {
    return work();
  } catch (e) {
    if (e instanceof OptionPriceReviewClientError) throw e;
    return fail();
  }
}
function choice<const T extends string>(v: unknown, values: readonly T[]): T {
  for (const value of values) if (value === v) return value;
  return fail();
}
function positive(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1 || v > 2147483647) return fail();
  return v;
}
const optionalRef = (v: unknown) => (v === null ? null : ref(v));
const optionalInstant = (v: unknown) => (v === null ? null : instant(v));
function hash(v: unknown): string {
  if (typeof v !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(v)) return fail();
  return v;
}
function lifecycle<const T extends string>(v: unknown, states: readonly T[]) {
  const r = record(v, [
    "lifecycleReference",
    "version",
    "state",
    "latestMutationOperationReference",
  ]);
  return Object.freeze({
    lifecycleReference: ref(r.lifecycleReference),
    version: positive(r.version),
    state: choice(r.state, states),
    latestMutationOperationReference: ref(r.latestMutationOperationReference),
  });
}
export function parseOptionPriceReviewCommand(value: unknown) {
  return safe(() => {
    const r = record(copy(value), [
      "action",
      "operationReference",
      "ruleReference",
      "draftVersionReference",
      "draftSnapshotDigest",
      "expectedAggregateVersion",
      "validationValidUntil",
      "approvalValidUntil",
      "expectedLifecycle",
    ]);
    const action = choice(r.action, ["SubmitReview", "Approve"] as const),
      expectedLifecycle =
        r.expectedLifecycle === null
          ? null
          : lifecycle(r.expectedLifecycle, ["Draft", "InReview"] as const),
      validationValidUntil = instant(r.validationValidUntil),
      approvalValidUntil = optionalInstant(r.approvalValidUntil);
    if (
      action === "SubmitReview"
        ? approvalValidUntil !== null ||
          (expectedLifecycle !== null && expectedLifecycle.state !== "Draft")
        : approvalValidUntil === null ||
          expectedLifecycle?.state !== "InReview" ||
          approvalValidUntil > validationValidUntil
    )
      return fail();
    return Object.freeze({
      action,
      operationReference: ref(r.operationReference),
      ruleReference: ref(r.ruleReference),
      draftVersionReference: ref(r.draftVersionReference),
      draftSnapshotDigest: hash(r.draftSnapshotDigest),
      expectedAggregateVersion: positive(r.expectedAggregateVersion),
      validationValidUntil,
      approvalValidUntil,
      expectedLifecycle,
    });
  });
}
export type OptionPriceReviewCommand = ReturnType<typeof parseOptionPriceReviewCommand>;
function context(v: unknown) {
  const r = record(v, [
    "productReference",
    "expectedProductAggregateVersion",
    "bindingReference",
    "optionReference",
  ]);
  return Object.freeze({
    productReference: ref(r.productReference),
    expectedProductAggregateVersion: positive(r.expectedProductAggregateVersion),
    bindingReference: ref(r.bindingReference),
    optionReference: ref(r.optionReference),
  });
}
function scopeFrom(r: Record<string, unknown>, expected: OptionPriceAuthoringScope) {
  const result = parseOptionSetAuthoringScope({
    tenantReference: r.tenantReference,
    brandReference: r.brandReference,
    storeReference: r.storeReference,
    actorReference: r.actorReference,
  });
  if (!same(result, expected)) return fail("ScopeChanged");
  return result;
}
function lease(observed: unknown, until: unknown) {
  const observedAt = instant(observed),
    validUntil = instant(until);
  if (validUntil <= observedAt || Date.parse(validUntil) - Date.parse(observedAt) > 5000)
    return fail();
  if (Date.now() < Date.parse(observedAt) || Date.now() >= Date.parse(validUntil))
    return fail("Stale");
  return { observedAt, validUntil };
}
function currentResult(value: unknown, scope: OptionPriceAuthoringScope, ruleReference: string) {
  const r = record(copy(value), [
    "profile",
    "tenantReference",
    "brandReference",
    "storeReference",
    "actorReference",
    "ruleReference",
    "aggregateVersion",
    "draftVersionReference",
    "draftSnapshotDigest",
    "draftAuthorActorReference",
    "policy",
    "review",
    "observedAt",
    "validUntil",
  ]);
  if (r.profile !== "MerchantOptionPriceReviewCurrentV1" || r.ruleReference !== ruleReference)
    return fail();
  const actualScope = scopeFrom(r, scope),
    p = record(r.policy, [
      "familyReference",
      "policyReference",
      "policyVersion",
      "approvalPolicy",
      "effectiveFrom",
      "effectiveUntil",
      "currentPublicationReference",
    ]),
    effectiveFrom = instant(p.effectiveFrom),
    effectiveUntil = optionalInstant(p.effectiveUntil);
  if (effectiveUntil !== null && effectiveUntil <= effectiveFrom) return fail();
  const policy = Object.freeze({
    familyReference: ref(p.familyReference),
    policyReference: ref(p.policyReference),
    policyVersion: positive(p.policyVersion),
    approvalPolicy: choice(p.approvalPolicy, ["Required", "NotRequired"] as const),
    effectiveFrom,
    effectiveUntil,
    currentPublicationReference: ref(p.currentPublicationReference),
  });
  const raw = r.review;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const review = (() => {
    const discriminator = Object.getOwnPropertyDescriptor(raw, "outcome");
    if (!discriminator?.enumerable || !("value" in discriminator)) return fail();
    if (discriminator.value === "Absent") {
      record(raw, ["outcome"]);
      return Object.freeze({ outcome: "Absent" as const });
    }
    const v = record(raw, [
      "outcome",
      "lifecycle",
      "validationValidUntil",
      "approvalValidUntil",
      "submittedActorReference",
      "approvedActorReference",
      "sourceAuthority",
      "qualification",
    ]);
    if (
      v.outcome !== "Recorded" ||
      v.sourceAuthority !== "RecordedHistory" ||
      v.qualification !== "NotEvaluated"
    )
      return fail();
    const validationValidUntil = optionalInstant(v.validationValidUntil),
      approvalValidUntil = optionalInstant(v.approvalValidUntil);
    if (
      approvalValidUntil !== null &&
      (validationValidUntil === null || approvalValidUntil > validationValidUntil)
    )
      return fail();
    return Object.freeze({
      outcome: "Recorded" as const,
      lifecycle: lifecycle(v.lifecycle, [
        "Draft",
        "InReview",
        "Approved",
        "Published",
        "Archived",
        "Superseded",
      ] as const),
      validationValidUntil,
      approvalValidUntil,
      submittedActorReference: optionalRef(v.submittedActorReference),
      approvedActorReference: optionalRef(v.approvedActorReference),
      sourceAuthority: "RecordedHistory" as const,
      qualification: "NotEvaluated" as const,
    });
  })();
  return Object.freeze({
    profile: "MerchantOptionPriceReviewCurrentV1" as const,
    ...actualScope,
    ruleReference: ref(r.ruleReference),
    aggregateVersion: positive(r.aggregateVersion),
    draftVersionReference: ref(r.draftVersionReference),
    draftSnapshotDigest: hash(r.draftSnapshotDigest),
    draftAuthorActorReference: ref(r.draftAuthorActorReference),
    policy,
    review,
    ...lease(r.observedAt, r.validUntil),
  });
}
export type OptionPriceReviewCurrent = ReturnType<typeof currentResult>;
function receipt(
  value: unknown,
  scope: OptionPriceAuthoringScope,
  command: OptionPriceReviewCommand,
) {
  const r = record(copy(value), [
    "profile",
    "action",
    "operationReference",
    "tenantReference",
    "brandReference",
    "storeReference",
    "actorReference",
    "outcome",
    "occurredAt",
    "observedAt",
    "validUntil",
  ]);
  if (
    r.profile !== "MerchantOptionPriceReviewResultV1" ||
    r.action !== command.action ||
    r.operationReference !== command.operationReference
  )
    return fail();
  const actualScope = scopeFrom(r, scope),
    outcome = choice(r.outcome, ["Committed", "Abandoned"] as const),
    window = lease(r.observedAt, r.validUntil),
    occurredAt = instant(r.occurredAt);
  if (occurredAt > window.observedAt) return fail();
  return Object.freeze({
    profile: "MerchantOptionPriceReviewResultV1" as const,
    action: command.action,
    operationReference: command.operationReference,
    ...actualScope,
    outcome,
    occurredAt,
    ...window,
  });
}
export type OptionPriceReviewResult = ReturnType<typeof receipt>;
export function createOptionPriceReviewClient(fetcher: typeof fetch = globalThis.fetch) {
  const transport = fetcher.bind(globalThis),
    definitive = new WeakSet<OptionPriceReviewClientError>();
  function serverError(code: OptionPriceAuthoringClientCode): never {
    const error = new OptionPriceReviewClientError(code);
    definitive.add(error);
    throw error;
  }
  async function post(
    path: string,
    body: string,
    scope: OptionPriceAuthoringScope,
    control: OptionPriceRequestControl,
  ) {
    if (typeof control.csrf !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(control.csrf))
      return fail();
    if (control.signal?.aborted) return fail("Unavailable");
    const controller = new AbortController();
    let rejectAbort: ((reason: unknown) => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const abort = () => {
      controller.abort();
      rejectAbort?.(new OptionPriceReviewClientError("Unavailable"));
    };
    control.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 15000);
    try {
      const response = await Promise.race([
        transport(path, {
          method: "POST",
          credentials: "same-origin",
          redirect: "error",
          cache: "no-store",
          body,
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-BOP-CSRF": control.csrf,
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
      let text = "",
        bytes = 0;
      try {
        while (true) {
          const chunk = await Promise.race([reader.read(), aborted]);
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 65536) return fail("Unavailable");
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      const value: unknown = JSON.parse(text);
      if (response.status !== 200) {
        const error = record(copy(value), ["error"]).error;
        if ((response.status === 401 || response.status === 403) && error === "request_denied")
          return serverError("Denied");
        if (response.status === 409 && error === "option_price_conflict")
          return serverError("Conflict");
        if (response.status === 409 && error === "option_price_feature_disabled")
          return serverError("FeatureDisabled");
        if (
          (response.status === 400 || response.status === 413) &&
          error === "option_price_invalid"
        )
          return serverError("Invalid");
        return fail("Unavailable");
      }
      return value;
    } catch (e) {
      if (e instanceof OptionPriceReviewClientError) throw e;
      return fail("Unavailable");
    } finally {
      controller.abort();
      clearTimeout(timer);
      control.signal?.removeEventListener("abort", abort);
    }
  }
  const serialize = (v: unknown) => {
    const body = JSON.stringify(v);
    if (new TextEncoder().encode(body).byteLength > 8192) return fail();
    return body;
  };
  return Object.freeze({
    async query(
      input: OptionPriceRequestControl & {
        readonly ruleReference: unknown;
        readonly context: unknown;
        readonly expectedScope: unknown;
      },
    ) {
      const scope = safe(() => parseOptionSetAuthoringScope(copy(input.expectedScope))),
        ruleReference = safe(() => ref(input.ruleReference)),
        selected = safe(() => context(copy(input.context)));
      const raw = await post(
        "/merchant/pricing/option-prices/review/current",
        serialize({ ruleReference, context: selected }),
        scope,
        input,
      );
      try {
        const result = currentResult(raw, scope, ruleReference);
        if (!same(parseOptionSetAuthoringScope(copy(input.expectedScope)), scope))
          return fail("ScopeChanged");
        if (input.signal?.aborted) return fail("Unavailable");
        return result;
      } catch (e) {
        if (
          e instanceof OptionPriceReviewClientError &&
          (e.code === "ScopeChanged" || e.code === "Stale")
        )
          throw e;
        return fail("Unavailable");
      }
    },
    prepare(input: {
      readonly command: unknown;
      readonly context: unknown;
      readonly expectedScope: unknown;
    }) {
      const scope = safe(() => parseOptionSetAuthoringScope(copy(input.expectedScope))),
        command = parseOptionPriceReviewCommand(input.command),
        selected = safe(() => context(copy(input.context))),
        body = serialize({ command, context: selected }),
        resolveBody = serialize({ command });
      let pending = false,
        active = false;
      async function attempt(
        resolve: boolean,
        control: OptionPriceRequestControl & { readonly scope?: unknown },
      ) {
        if (active) return fail(pending ? "OutcomeUnknown" : "Unavailable");
        if (control.scope !== undefined) {
          let matches: boolean;
          try {
            matches = same(parseOptionSetAuthoringScope(copy(control.scope)), scope);
          } catch {
            return fail("ScopeChanged");
          }
          if (!matches) return fail("ScopeChanged");
        }
        if (control.signal?.aborted) return fail(pending ? "OutcomeUnknown" : "Unavailable");
        if (typeof control.csrf !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(control.csrf)) {
          if (pending) throw new OptionPriceReviewClientError("OutcomeUnknown", "Invalid");
          return fail();
        }
        active = true;
        const wasPending = pending;
        pending = true;
        try {
          const raw = await post(
              resolve
                ? "/merchant/pricing/option-prices/review/resolve"
                : "/merchant/pricing/option-prices/review/command",
              resolve ? resolveBody : body,
              scope,
              control,
            ),
            result = receipt(raw, scope, command);
          if (control.signal?.aborted) return fail("Unavailable");
          if (
            control.scope !== undefined &&
            !same(parseOptionSetAuthoringScope(copy(control.scope)), scope)
          )
            return fail("ScopeChanged");
          pending = false;
          return result;
        } catch (e) {
          const attemptCode = e instanceof OptionPriceReviewClientError ? e.code : "Unavailable";
          if (
            !wasPending &&
            !resolve &&
            e instanceof OptionPriceReviewClientError &&
            definitive.has(e)
          ) {
            pending = false;
            throw e;
          }
          throw new OptionPriceReviewClientError("OutcomeUnknown", attemptCode);
        } finally {
          active = false;
        }
      }
      return Object.freeze({
        command,
        context: selected,
        scope,
        get pending() {
          return pending;
        },
        execute: (control: OptionPriceRequestControl & { readonly scope?: unknown }) =>
          attempt(false, control),
        resolve: (control: OptionPriceRequestControl & { readonly scope?: unknown }) =>
          attempt(true, control),
      });
    },
  });
}
