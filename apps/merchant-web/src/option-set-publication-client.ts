import {
  productCommandRecord as record,
  parseCatalogReference as ref,
  parseCatalogInstant as instant,
} from "./catalog-product-command-values.js";
import {
  canonicalPublicationValue as canonical,
  publicationValueDigest as digest,
} from "./product-publication-command-client-v2.js";
import {
  parseOptionSetAuthoringScope,
  type OptionSetAuthoringScope,
} from "./option-set-authoring-client.js";
export type OptionSetPublicationAction = "SubmitReview" | "Approve" | "Publish";
export type OptionSetPublicationObservation = "Inspect" | "Validate" | OptionSetPublicationAction;
export class OptionSetPublicationClientError extends Error {
  constructor(
    readonly code:
      | "Invalid"
      | "Denied"
      | "Disabled"
      | "Conflict"
      | "Unavailable"
      | "OutcomeUnknown"
      | "Stale"
      | "ScopeChanged",
    readonly attemptCode?: "Invalid" | "Denied" | "Disabled" | "Conflict",
  ) {
    super("Option Set publication request could not be confirmed");
    this.name = "OptionSetPublicationClientError";
  }
}
const fail = (c: OptionSetPublicationClientError["code"] = "Invalid"): never => {
  throw new OptionSetPublicationClientError(c);
};
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function integer(v: unknown) {
  if (!Number.isSafeInteger(v) || Number(v) < 1 || Number(v) > 2147483647) return fail();
  return Number(v);
}
function hash(v: unknown) {
  return typeof v === "string" && /^sha256:[0-9a-f]{64}$/u.test(v) ? v : fail();
}
function choice<T extends string>(v: unknown, choices: readonly T[]): T {
  for (const c of choices) if (v === c) return c;
  return fail();
}
function copy(value: unknown): unknown {
  let budget = 100000;
  const seen = new WeakSet<object>();
  function visit(v: unknown, depth: number): unknown {
    if (--budget < 0 || depth > 12) return fail();
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "string") return v.length <= 8192 ? v : fail();
    if (typeof v === "number") return Number.isFinite(v) ? v : fail();
    if (!v || typeof v !== "object" || seen.has(v)) return fail();
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        if (
          Object.getPrototypeOf(v) !== Array.prototype ||
          v.length > 10000 ||
          Reflect.ownKeys(v).length !== v.length + 1
        )
          return fail();
        return Object.freeze(
          Array.from({ length: v.length }, (_, i) => {
            const d = Object.getOwnPropertyDescriptor(v, String(i));
            if (!d?.enumerable || !("value" in d)) return fail();
            return visit(d.value, depth + 1);
          }),
        );
      }
      if (Object.getPrototypeOf(v) !== Object.prototype || Reflect.ownKeys(v).length > 128)
        return fail();
      return Object.freeze(
        Object.fromEntries(
          Reflect.ownKeys(v).map((k) => {
            if (typeof k !== "string") return fail();
            const d = Object.getOwnPropertyDescriptor(v, k);
            if (!d?.enumerable || !("value" in d)) return fail();
            return [k, visit(d.value, depth + 1)];
          }),
        ),
      );
    } finally {
      seen.delete(v);
    }
  }
  return visit(value, 0);
}
function closed(v: unknown, keys: readonly string[]) {
  try {
    return record(copy(v), keys);
  } catch {
    return fail();
  }
}
function freeze<T>(v: T): T {
  if (v && typeof v === "object") {
    for (const x of Object.values(v)) freeze(x);
    Object.freeze(v);
  }
  return v;
}
export const optionSetPublicationChecks = [
  "CURRENT_REFERENCES",
  "PUBLISHING_POLICY",
  "RULE_SATISFIABILITY",
  "SCOPE_TOPOLOGY",
] as const;
type Scope = OptionSetAuthoringScope;
export type OptionSetPublicationScope = Pick<Scope, "brandReference" | "storeReference">;
const scopeAnchor = (s: OptionSetPublicationScope): OptionSetPublicationScope => ({
  brandReference: s.brandReference,
  storeReference: s.storeReference,
});
const selected = (v: unknown): OptionSetPublicationScope => {
  const r = closed(v, ["brandReference", "storeReference"]);
  return freeze({ brandReference: ref(r.brandReference), storeReference: ref(r.storeReference) });
};
function root(v: unknown) {
  const r = closed(v, [
    "optionSetReference",
    "versionReference",
    "expectedAggregateVersion",
    "sourceDigest",
    "contentDigest",
    "configurationDigest",
  ]);
  return freeze({
    optionSetReference: ref(r.optionSetReference),
    versionReference: ref(r.versionReference),
    expectedAggregateVersion: integer(r.expectedAggregateVersion),
    sourceDigest: hash(r.sourceDigest),
    contentDigest: hash(r.contentDigest),
    configurationDigest: hash(r.configurationDigest),
  });
}
function reviewTuple(v: unknown) {
  if (v === null) return null;
  const r = closed(v, [
    "reviewOperationReference",
    "publishingReviewOperationReference",
    "recordDigest",
    "bindingDigest",
  ]);
  return freeze({
    reviewOperationReference: ref(r.reviewOperationReference),
    publishingReviewOperationReference: ref(r.publishingReviewOperationReference),
    recordDigest: hash(r.recordDigest),
    bindingDigest: hash(r.bindingDigest),
  });
}
function lifecycleTuple(v: unknown) {
  if (v === null) return null;
  const r = closed(v, [
    "lifecycleReference",
    "version",
    "state",
    "latestMutationOperationReference",
  ]);
  return freeze({
    lifecycleReference: ref(r.lifecycleReference),
    version: integer(r.version),
    state: choice(r.state, ["Draft", "InReview", "Approved"] as const),
    latestMutationOperationReference: ref(r.latestMutationOperationReference),
  });
}
export function parseOptionSetPublicationCommand(v: unknown) {
  const r = closed(v, [
    "profile",
    "action",
    "operationReference",
    "optionSetReference",
    "versionReference",
    "expectedAggregateVersion",
    "sourceDigest",
    "contentDigest",
    "configurationDigest",
    "expectedReview",
    "expectedLifecycle",
  ]);
  if (r.profile !== "CatalogOptionSetPublicationCommandRequestV1") return fail();
  const action = choice(r.action, ["SubmitReview", "Approve", "Publish"] as const),
    expectedReview = reviewTuple(r.expectedReview),
    expectedLifecycle = lifecycleTuple(r.expectedLifecycle);
  if (
    action === "SubmitReview"
      ? expectedReview !== null ||
        (expectedLifecycle !== null && expectedLifecycle.state !== "Draft")
      : !expectedReview ||
        !expectedLifecycle ||
        (action === "Approve" && expectedLifecycle.state !== "InReview") ||
        (action === "Publish" && expectedLifecycle.state === "Draft")
  )
    return fail();
  if (
    expectedReview &&
    expectedLifecycle?.state === "InReview" &&
    expectedReview.publishingReviewOperationReference !==
      expectedLifecycle.latestMutationOperationReference
  )
    return fail();
  return freeze({
    profile: "CatalogOptionSetPublicationCommandRequestV1" as const,
    action,
    operationReference: ref(r.operationReference),
    ...root(
      Object.fromEntries(
        [
          "optionSetReference",
          "versionReference",
          "expectedAggregateVersion",
          "sourceDigest",
          "contentDigest",
          "configurationDigest",
        ].map((k) => [k, r[k]]),
      ),
    ),
    expectedReview,
    expectedLifecycle,
  });
}
export type OptionSetPublicationCommand = ReturnType<typeof parseOptionSetPublicationCommand>;
export interface OptionSetPublicationCursor {
  readonly profile: "CatalogOptionSetPublicationCursorV1";
  readonly scope: Scope;
  readonly command: OptionSetPublicationCommand;
}
export function parseOptionSetPublicationCursor(v: unknown): OptionSetPublicationCursor {
  const r = closed(v, ["profile", "scope", "command"]);
  if (r.profile !== "CatalogOptionSetPublicationCursorV1") return fail();
  return freeze({
    profile: "CatalogOptionSetPublicationCursorV1",
    scope: parseOptionSetAuthoringScope(r.scope),
    command: parseOptionSetPublicationCommand(r.command),
  });
}
async function binding(v: unknown) {
  const r = closed(v, [
    "profile",
    "tenantReference",
    "brandReference",
    "optionSetReference",
    "versionReference",
    "expectedAggregateVersion",
    "sourceDigest",
    "contentDigest",
    "configurationDigest",
    "graphDigest",
    "policyReference",
    "policyVersion",
    "policyContentDigest",
    "currentPolicyPublicationReference",
    "originalIntentDigest",
    "activationAt",
    "digest",
  ]);
  if (r.profile !== "CatalogOptionSetContentReviewBindingV1") return fail();
  const body = {
    profile: "CatalogOptionSetContentReviewBindingV1" as const,
    tenantReference: ref(r.tenantReference),
    brandReference: ref(r.brandReference),
    ...root(
      Object.fromEntries(
        [
          "optionSetReference",
          "versionReference",
          "expectedAggregateVersion",
          "sourceDigest",
          "contentDigest",
          "configurationDigest",
        ].map((k) => [k, r[k]]),
      ),
    ),
    graphDigest: hash(r.graphDigest),
    policyReference: ref(r.policyReference),
    policyVersion: integer(r.policyVersion),
    policyContentDigest: hash(r.policyContentDigest),
    currentPolicyPublicationReference: ref(r.currentPolicyPublicationReference),
    originalIntentDigest: hash(r.originalIntentDigest),
    activationAt: instant(r.activationAt),
  };
  if ((await digest(body)) !== hash(r.digest)) return fail();
  return freeze({ ...body, digest: hash(r.digest) });
}
function lifecycle(v: unknown) {
  const r = closed(v, [
      "lifecycleId",
      "familyReference",
      "configurationType",
      "purposeCode",
      "snapshotReference",
      "snapshotDigest",
      "scope",
      "version",
      "state",
      "validationEvidenceReference",
      "approvalEvidenceReference",
      "createdAt",
      "changedAt",
    ]),
    s = closed(r.scope, ["kind", "brandReference", "storeReference"]);
  if (
    s.kind !== "Brand" ||
    s.storeReference !== null ||
    r.configurationType !== "CATALOG_OPTION_SET" ||
    r.purposeCode !== "CATALOG_OPTION_SET_PUBLICATION"
  )
    return fail();
  const createdAt = instant(r.createdAt),
    changedAt = instant(r.changedAt);
  if (createdAt > changedAt) return fail();
  return freeze({
    lifecycleId: ref(r.lifecycleId),
    familyReference: ref(r.familyReference),
    configurationType: "CATALOG_OPTION_SET" as const,
    purposeCode: "CATALOG_OPTION_SET_PUBLICATION" as const,
    snapshotReference: ref(r.snapshotReference),
    snapshotDigest: hash(r.snapshotDigest),
    scope: { kind: "Brand" as const, brandReference: ref(s.brandReference), storeReference: null },
    version: integer(r.version),
    state: choice(r.state, [
      "Draft",
      "InReview",
      "Approved",
      "Published",
      "Archived",
      "Superseded",
    ] as const),
    validationEvidenceReference:
      r.validationEvidenceReference === null ? null : ref(r.validationEvidenceReference),
    approvalEvidenceReference:
      r.approvalEvidenceReference === null ? null : ref(r.approvalEvidenceReference),
    createdAt,
    changedAt,
  });
}
export async function parseOptionSetPublicationContext(v: unknown) {
  const r = closed(v, [
    "profile",
    "action",
    "tenantReference",
    "brandReference",
    "storeReference",
    "actorReference",
    "observedAt",
    "validUntil",
    "draft",
    "review",
  ]);
  if (r.profile !== "CatalogOptionSetPublicationContextV1") return fail();
  const scope = parseOptionSetAuthoringScope(
      Object.fromEntries(
        ["tenantReference", "brandReference", "storeReference", "actorReference"].map((k) => [
          k,
          r[k],
        ]),
      ),
    ),
    observedAt = instant(r.observedAt),
    validUntil = instant(r.validUntil);
  if (validUntil <= observedAt || Date.parse(validUntil) - Date.parse(observedAt) > 5000)
    return fail();
  const d = closed(r.draft, [
      "optionSetReference",
      "versionReference",
      "aggregateVersion",
      "sourceOperationReference",
      "sourceSnapshotTuple",
      "sourceDigest",
      "contentDigest",
      "configurationDigest",
    ]),
    draft = {
      ...root({
        optionSetReference: d.optionSetReference,
        versionReference: d.versionReference,
        expectedAggregateVersion: d.aggregateVersion,
        sourceDigest: d.sourceDigest,
        contentDigest: d.contentDigest,
        configurationDigest: d.configurationDigest,
      }),
      sourceOperationReference: ref(d.sourceOperationReference),
    };
  const t = closed(d.sourceSnapshotTuple, [
    "tenantReference",
    "brandReference",
    "optionSetReference",
    "versionReference",
    "aggregateVersion",
    "sourceDigest",
    "contentDigest",
    "configurationDigest",
  ]);
  if (t.tenantReference !== scope.tenantReference || t.brandReference !== scope.brandReference)
    return fail();
  for (const k of [
    "optionSetReference",
    "versionReference",
    "sourceDigest",
    "contentDigest",
    "configurationDigest",
  ] as const)
    if (t[k] !== draft[k]) return fail();
  if (integer(t.aggregateVersion) !== draft.expectedAggregateVersion) return fail();
  const rr = closed(
    r.review,
    (r.review as { kind?: unknown } | null)?.kind === "Recorded"
      ? [
          "kind",
          "operationReference",
          "lifecycleReference",
          "submittedActorReference",
          "recordedAt",
          "recordDigest",
          "latestMutationOperationReference",
          "publishingReviewOperationReference",
          "binding",
          "lifecycle",
        ]
      : ["kind"],
  );
  let review:
    | { readonly kind: "AbsentForCurrentDraft" }
    | {
        readonly kind: "Recorded";
        readonly operationReference: string;
        readonly lifecycleReference: string;
        readonly submittedActorReference: string;
        readonly recordedAt: string;
        readonly recordDigest: string;
        readonly latestMutationOperationReference: string;
        readonly publishingReviewOperationReference: string;
        readonly binding: Awaited<ReturnType<typeof binding>>;
        readonly lifecycle: ReturnType<typeof lifecycle>;
      };
  if (rr.kind === "AbsentForCurrentDraft") review = { kind: "AbsentForCurrentDraft" };
  else {
    if (rr.kind !== "Recorded") return fail();
    const b = await binding(rr.binding),
      l = lifecycle(rr.lifecycle),
      recordedAt = instant(rr.recordedAt),
      op = ref(rr.publishingReviewOperationReference),
      latest = ref(rr.latestMutationOperationReference);
    if (
      b.tenantReference !== scope.tenantReference ||
      b.brandReference !== scope.brandReference ||
      l.scope.brandReference !== scope.brandReference ||
      l.familyReference !== draft.optionSetReference ||
      l.lifecycleId !== ref(rr.lifecycleReference) ||
      l.snapshotReference !== draft.versionReference ||
      l.snapshotDigest !== b.digest ||
      recordedAt > observedAt ||
      l.changedAt > observedAt ||
      b.activationAt > recordedAt
    )
      return fail();
    for (const k of [
      "optionSetReference",
      "versionReference",
      "expectedAggregateVersion",
      "sourceDigest",
      "contentDigest",
      "configurationDigest",
    ] as const)
      if (b[k] !== draft[k]) return fail();
    if (l.state === "InReview" && latest !== op) return fail();
    if (["InReview", "Approved", "Published"].includes(l.state) && !l.validationEvidenceReference)
      return fail();
    if (l.state === "Approved" && !l.approvalEvidenceReference) return fail();
    review = {
      kind: "Recorded",
      operationReference: ref(rr.operationReference),
      lifecycleReference: l.lifecycleId,
      submittedActorReference: ref(rr.submittedActorReference),
      recordedAt,
      recordDigest: hash(rr.recordDigest),
      latestMutationOperationReference: latest,
      publishingReviewOperationReference: op,
      binding: b,
      lifecycle: l,
    };
  }
  return freeze({
    profile: "CatalogOptionSetPublicationContextV1" as const,
    action: choice(r.action, [
      "Inspect",
      "Validate",
      "SubmitReview",
      "Approve",
      "Publish",
    ] as const),
    scope,
    observedAt,
    validUntil,
    draft,
    review,
  });
}
export type OptionSetPublicationContext = Awaited<
  ReturnType<typeof parseOptionSetPublicationContext>
>;
function fresh(c: OptionSetPublicationContext) {
  if (Date.now() >= Date.parse(c.validUntil) || Date.parse(c.observedAt) > Date.now() + 300000)
    return fail("Stale");
}
function report(v: unknown) {
  const r = closed(v, [
    "checks",
    "findings",
    "decision",
    "observedAt",
    "qualifiedActivationAt",
    "independentApproval",
    "saleEligibility",
  ]);
  if (
    !Array.isArray(r.checks) ||
    r.checks.length !== 4 ||
    !Array.isArray(r.findings) ||
    r.findings.length > 10000 ||
    r.independentApproval !== "NotEvaluated" ||
    r.saleEligibility !== "NotEvaluated"
  )
    return fail();
  const checks = r.checks.map((v) => {
    const x = closed(v, ["code", "outcome"]);
    return freeze({
      code: choice(x.code, optionSetPublicationChecks),
      outcome: choice(x.outcome, ["Pass", "HardError", "Indeterminate"] as const),
    });
  });
  if (new Set(checks.map((x) => x.code)).size !== 4) return fail();
  const findings = r.findings.map((v) => {
      const x = closed(v, [
        "checkCode",
        "ruleCode",
        "outcome",
        "optionSetReference",
        "optionReference",
        "reference",
      ]);
      return freeze({
        checkCode: choice(x.checkCode, optionSetPublicationChecks),
        ruleCode:
          typeof x.ruleCode === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(x.ruleCode)
            ? x.ruleCode
            : fail(),
        outcome: choice(x.outcome, ["Pass", "HardError", "Indeterminate"] as const),
        optionSetReference: x.optionSetReference === null ? null : ref(x.optionSetReference),
        optionReference: x.optionReference === null ? null : ref(x.optionReference),
        reference: x.reference === null ? null : ref(x.reference),
      });
    }),
    decision = choice(r.decision, ["Pass", "HardError", "Indeterminate"] as const),
    observedAt = instant(r.observedAt),
    qualifiedActivationAt = instant(r.qualifiedActivationAt);
  const expected = checks.some((x) => x.outcome === "HardError")
    ? "HardError"
    : checks.some((x) => x.outcome === "Indeterminate")
      ? "Indeterminate"
      : "Pass";
  if (
    decision !== expected ||
    findings.some(
      (f) =>
        f.outcome === "HardError" &&
        checks.find((c) => c.code === f.checkCode)?.outcome !== "HardError",
    )
  )
    return fail();
  return freeze({
    checks,
    findings,
    decision,
    observedAt,
    qualifiedActivationAt,
    independentApproval: "NotEvaluated" as const,
    saleEligibility: "NotEvaluated" as const,
  });
}
export type OptionSetPublicationReport = ReturnType<typeof report>;
export interface OptionSetPublicationReceipt {
  readonly profile: "CatalogOptionSetPublicationReceiptV1";
  readonly storeReference: string;
  readonly operationReference: string;
  readonly action: OptionSetPublicationAction;
  readonly outcome: "Committed" | "Abandoned";
  readonly recordedAt: string;
}
function receipt(v: unknown, c: OptionSetPublicationCursor): OptionSetPublicationReceipt {
  const r = closed(v, [
    "profile",
    "storeReference",
    "operationReference",
    "action",
    "outcome",
    "recordedAt",
  ]);
  if (
    r.profile !== "CatalogOptionSetPublicationReceiptV1" ||
    r.storeReference !== c.scope.storeReference ||
    r.operationReference !== c.command.operationReference ||
    r.action !== c.command.action
  )
    return fail();
  const recordedAt = instant(r.recordedAt);
  if (Date.parse(recordedAt) > Date.now() + 300000) return fail();
  return freeze({
    profile: "CatalogOptionSetPublicationReceiptV1",
    storeReference: ref(r.storeReference),
    operationReference: ref(r.operationReference),
    action: c.command.action,
    outcome: choice(r.outcome, ["Committed", "Abandoned"] as const),
    recordedAt,
  });
}
export function createOptionSetPublicationClient(fetcher: typeof fetch = globalThis.fetch) {
  const transport = fetcher.bind(globalThis),
    definitive = new WeakSet<OptionSetPublicationClientError>();
  const serverError = (c: "Denied" | "Conflict" | "Invalid" | "Disabled"): never => {
    const e = new OptionSetPublicationClientError(c);
    definitive.add(e);
    throw e;
  };
  async function post(
    path: string,
    body: string,
    s: OptionSetPublicationScope,
    csrf: string,
    signal: AbortSignal | undefined,
    write: boolean,
  ) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(csrf)) return fail();
    if (signal?.aborted) return fail("Unavailable");
    const controller = new AbortController();
    let rejectAbort: ((e: unknown) => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
        rejectAbort = reject;
      }),
      abort = () => {
        controller.abort();
        rejectAbort?.(
          new OptionSetPublicationClientError(write ? "OutcomeUnknown" : "Unavailable"),
        );
      };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 15000);
    try {
      const response = await Promise.race([
        transport("/merchant/catalog/option-sets/publication/" + path, {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
          body,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-BOP-CSRF": csrf,
            "X-BOP-Catalog-Scope": btoa(JSON.stringify(s))
              .replace(/\+/gu, "-")
              .replace(/\//gu, "_")
              .replace(/=+$/u, ""),
          },
        }),
        aborted,
      ]);
      if (
        response.headers.get("cache-control") !== "no-store" ||
        !/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "") ||
        !response.body
      )
        return fail();
      const reader = response.body.getReader(),
        decoder = new TextDecoder("utf-8", { fatal: true });
      let text = "",
        bytes = 0;
      try {
        while (true) {
          const chunk = await Promise.race([reader.read(), aborted]);
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 2097152) return fail();
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      const value: unknown = JSON.parse(text);
      if (response.status !== 200) {
        const e = closed(value, ["error"]).error;
        if ((response.status === 401 || response.status === 403) && e === "request_denied")
          return serverError("Denied");
        if (
          response.status === 409 &&
          (e === "option_set_publication_conflict" ||
            e === "option_set_publication_context_conflict")
        )
          return serverError("Conflict");
        if (response.status === 409 && e === "option_set_publication_feature_disabled")
          return serverError("Disabled");
        if (
          (response.status === 400 || response.status === 413) &&
          (e === "option_set_publication_invalid" || e === "option_set_publication_context_invalid")
        )
          return serverError("Invalid");
        return fail("Unavailable");
      }
      return value;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  function prepare(
    c: OptionSetPublicationContext,
    action: OptionSetPublicationAction,
    operationReference: string,
  ) {
    fresh(c);
    if (c.action !== action) return fail();
    const r = c.review;
    const command = parseOptionSetPublicationCommand({
      profile: "CatalogOptionSetPublicationCommandRequestV1",
      action,
      operationReference,
      ...root(
        Object.fromEntries(
          [
            "optionSetReference",
            "versionReference",
            "expectedAggregateVersion",
            "sourceDigest",
            "contentDigest",
            "configurationDigest",
          ].map((k) => [k, Reflect.get(c.draft, k)]),
        ),
      ),
      expectedReview:
        r.kind === "Recorded"
          ? {
              reviewOperationReference: r.operationReference,
              publishingReviewOperationReference: r.publishingReviewOperationReference,
              recordDigest: r.recordDigest,
              bindingDigest: r.binding.digest,
            }
          : null,
      expectedLifecycle:
        r.kind === "Recorded"
          ? {
              lifecycleReference: r.lifecycleReference,
              version: r.lifecycle.version,
              state: r.lifecycle.state,
              latestMutationOperationReference: r.latestMutationOperationReference,
            }
          : null,
    });
    const cursor = parseOptionSetPublicationCursor({
        profile: "CatalogOptionSetPublicationCursorV1",
        scope: c.scope,
        command,
      }),
      body = canonical(command);
    let uncertain = false,
      active = false;
    return freeze({
      cursor,
      command,
      body,
      async execute(csrf: string, signal?: AbortSignal) {
        if (active) return fail("Conflict");
        active = true;
        try {
          return receipt(
            await post("command", body, scopeAnchor(c.scope), csrf, signal, true),
            cursor,
          );
        } catch (e) {
          if (e instanceof OptionSetPublicationClientError && definitive.has(e)) {
            if (!uncertain) throw e;
            throw new OptionSetPublicationClientError(
              "OutcomeUnknown",
              e.code === "Denied" ||
                e.code === "Conflict" ||
                e.code === "Invalid" ||
                e.code === "Disabled"
                ? e.code
                : undefined,
            );
          }
          uncertain = true;
          return fail("OutcomeUnknown");
        } finally {
          active = false;
        }
      },
    });
  }
  return freeze({
    prepare,
    async context(
      command: {
        optionSetReference: string;
        expectedAggregateVersion: number | null;
        action: OptionSetPublicationObservation;
      },
      scopeValue: unknown,
      csrf: string,
      signal?: AbortSignal,
    ) {
      const s = selected(scopeValue),
        optionSetReference = ref(command.optionSetReference),
        expectedAggregateVersion =
          command.expectedAggregateVersion === null
            ? null
            : integer(command.expectedAggregateVersion),
        action = choice(command.action, [
          "Inspect",
          "Validate",
          "SubmitReview",
          "Approve",
          "Publish",
        ] as const);
      try {
        const c = await parseOptionSetPublicationContext(
          await post(
            "context",
            canonical({ optionSetReference, expectedAggregateVersion, action }),
            s,
            csrf,
            signal,
            false,
          ),
        );
        if (
          c.action !== action ||
          c.scope.brandReference !== s.brandReference ||
          c.scope.storeReference !== s.storeReference ||
          c.draft.optionSetReference !== optionSetReference
        )
          return fail("ScopeChanged");
        if (
          expectedAggregateVersion !== null &&
          c.draft.expectedAggregateVersion !== expectedAggregateVersion
        )
          return fail("Conflict");
        fresh(c);
        return c;
      } catch (e) {
        if (e instanceof OptionSetPublicationClientError) throw e;
        return fail("Unavailable");
      }
    },
    async validate(c: OptionSetPublicationContext, csrf: string, signal?: AbortSignal) {
      fresh(c);
      if (c.action !== "Validate") return fail();
      const r = closed(
        await post(
          "command",
          canonical({
            profile: "CatalogOptionSetPublicationCommandRequestV1",
            action: "Validate",
            ...root(
              Object.fromEntries(
                [
                  "optionSetReference",
                  "versionReference",
                  "expectedAggregateVersion",
                  "sourceDigest",
                  "contentDigest",
                  "configurationDigest",
                ].map((k) => [k, Reflect.get(c.draft, k)]),
              ),
            ),
          }),
          scopeAnchor(c.scope),
          csrf,
          signal,
          false,
        ),
        ["profile", "storeReference", "outcome", "validation"],
      );
      if (
        r.profile !== "CatalogOptionSetPublicationCommandResultV1" ||
        r.storeReference !== c.scope.storeReference ||
        r.outcome !== "Validated"
      )
        return fail();
      return report(r.validation);
    },
    async resolve(value: unknown, scopeValue: unknown, csrf: string, signal?: AbortSignal) {
      const c = parseOptionSetPublicationCursor(value),
        s = parseOptionSetAuthoringScope(scopeValue);
      if (!same(c.scope, s)) return fail("ScopeChanged");
      try {
        return receipt(
          await post(
            "resolve",
            canonical({ ...c.command, profile: "CatalogOptionSetPublicationResolutionRequestV1" }),
            scopeAnchor(s),
            csrf,
            signal,
            true,
          ),
          c,
        );
      } catch (e) {
        if (e instanceof OptionSetPublicationClientError && definitive.has(e)) throw e;
        return fail("OutcomeUnknown");
      }
    },
  });
}
export type OptionSetPublicationClient = ReturnType<typeof createOptionSetPublicationClient>;
export type OptionSetPreparedPublication = ReturnType<OptionSetPublicationClient["prepare"]>;
