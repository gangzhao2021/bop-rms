import {
  productCommandRecord as record,
  parseCatalogReference as ref,
  parseCatalogInstant as instant,
} from "./catalog-product-command-values.js";
import {
  canonicalPublicationValue as canonical,
  publicationValueDigest,
} from "./product-publication-command-client-v2.js";
import {
  parseStoreSetupScope,
  StoreSetupClientError,
  type StoreSetupScope,
} from "./store-setup-client.js";
export { StoreSetupClientError as ReceiptTemplateSubmitClientError };
export interface ReceiptTemplateSubmission {
  readonly profile: "DigitalReceiptTemplateSubmissionV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly templateReference: string;
  readonly familyReference: string;
  readonly versionReference: string;
  readonly draftRevision: number;
  readonly contentDigest: string;
  readonly authoredByReference: string;
  readonly submittedByReference: string;
  readonly operationReference: string;
  readonly reviewLifecycleReference: string;
  readonly reviewVersion: number;
  readonly validationEvidenceReference: string;
  readonly checkedAt: string;
  readonly validationValidUntil: string;
  readonly submittedAt: string;
  readonly auditReference: string;
  readonly dataClassification: "Internal";
}
export interface ReceiptTemplateReviewCurrent extends StoreSetupScope {
  readonly profile: "DigitalReceiptTemplateReviewCurrentV1";
  readonly templateReference: string;
  readonly currentDraft: Readonly<{
    versionReference: string;
    revision: number;
    contentDigest: string;
  }>;
  readonly submission: ReceiptTemplateSubmission | null;
  readonly lifecycle: Readonly<{
    lifecycleReference: string;
    version: number;
    state: "InReview" | "Approved" | "Published" | "Archived";
    latestMutationOperationReference: string;
    changedAt: string;
    validationEvidenceReference: string;
    approvalEvidenceReference: string | null;
  }> | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly sourceQualification: "NotEvaluated";
}
export interface ReceiptTemplateSubmitCursor {
  readonly profile: "ReceiptTemplateSubmitPendingOriginalV1";
  readonly scope: StoreSetupScope;
  readonly templateReference: string;
  readonly operationReference: string;
  readonly expectedVersionReference: string;
  readonly expectedRevision: number;
  readonly intentDigest: string;
}
export interface ReceiptTemplateSubmitOriginal extends StoreSetupScope {
  readonly profile: "DigitalReceiptTemplateSubmitV1";
  readonly operationReference: string;
  readonly templateReference: string;
  readonly expectedVersionReference: string;
  readonly expectedRevision: number;
  readonly purposeCode: "RECEIPT_TEMPLATE_REVIEW";
}
export interface PreparedReceiptTemplateSubmit {
  readonly command: ReceiptTemplateSubmitOriginal;
  readonly cursor: ReceiptTemplateSubmitCursor;
  readonly intentDigest: string;
}
export interface ReceiptTemplateSubmitReceipt extends StoreSetupScope {
  readonly profile: "DigitalReceiptTemplateSubmitReceiptV1";
  readonly operationReference: string;
  readonly templateReference: string;
  readonly expectedVersionReference: string;
  readonly expectedRevision: number;
  readonly intentDigest: string;
  readonly outcome: "Committed" | "Abandoned";
  readonly submission: ReceiptTemplateSubmission | null;
  readonly auditReference: string;
  readonly occurredAt: string;
}
const fail = (code: StoreSetupClientError["code"] = "Invalid"): never => {
  throw new StoreSetupClientError(code);
};
function safe<T>(work: () => T): T {
  try {
    return work();
  } catch (e) {
    if (e instanceof StoreSetupClientError) throw e;
    return fail();
  }
}
const positive = (v: unknown, min = 1): number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= 2147483647 ? v : fail();
const hash = (v: unknown): string =>
  typeof v === "string" && /^sha256:[a-f0-9]{64}$/u.test(v) ? v : fail();
const scopeKeys = ["tenantReference", "brandReference", "storeReference", "actorReference"];
const scopeFrom = (r: Record<string, unknown>) =>
  parseStoreSetupScope({
    tenantReference: r.tenantReference,
    brandReference: r.brandReference,
    storeReference: r.storeReference,
    actorReference: r.actorReference,
  });
const sameScope = (a: StoreSetupScope, b: StoreSetupScope) => canonical(a) === canonical(b);
const pins = (r: Record<string, unknown>) => ({
  operationReference: ref(r.operationReference),
  templateReference: ref(r.templateReference),
  expectedVersionReference: ref(r.expectedVersionReference),
  expectedRevision: positive(r.expectedRevision),
});
function original(v: unknown): ReceiptTemplateSubmitOriginal {
  return safe(() => {
    const r = record(v, [
      "profile",
      ...scopeKeys,
      "operationReference",
      "templateReference",
      "expectedVersionReference",
      "expectedRevision",
      "purposeCode",
    ]);
    if (
      r.profile !== "DigitalReceiptTemplateSubmitV1" ||
      r.purposeCode !== "RECEIPT_TEMPLATE_REVIEW"
    )
      return fail();
    return Object.freeze({
      profile: "DigitalReceiptTemplateSubmitV1",
      ...scopeFrom(r),
      ...pins(r),
      purposeCode: "RECEIPT_TEMPLATE_REVIEW",
    });
  });
}
export function parseReceiptTemplateSubmitCursor(v: unknown): ReceiptTemplateSubmitCursor {
  return safe(() => {
    const r = record(v, [
      "profile",
      "scope",
      "operationReference",
      "templateReference",
      "expectedVersionReference",
      "expectedRevision",
      "intentDigest",
    ]);
    if (r.profile !== "ReceiptTemplateSubmitPendingOriginalV1") return fail();
    return Object.freeze({
      profile: "ReceiptTemplateSubmitPendingOriginalV1",
      scope: parseStoreSetupScope(r.scope),
      ...pins(r),
      intentDigest: hash(r.intentDigest),
    });
  });
}
export function parseReceiptTemplateSubmission(v: unknown): ReceiptTemplateSubmission {
  return safe(() => {
    const r = record(v, [
      "profile",
      "tenantReference",
      "brandReference",
      "storeReference",
      "templateReference",
      "familyReference",
      "versionReference",
      "draftRevision",
      "contentDigest",
      "authoredByReference",
      "submittedByReference",
      "operationReference",
      "reviewLifecycleReference",
      "reviewVersion",
      "validationEvidenceReference",
      "checkedAt",
      "validationValidUntil",
      "submittedAt",
      "auditReference",
      "dataClassification",
    ]);
    if (r.profile !== "DigitalReceiptTemplateSubmissionV1" || r.dataClassification !== "Internal")
      return fail();
    const checkedAt = instant(r.checkedAt),
      submittedAt = instant(r.submittedAt),
      validationValidUntil = instant(r.validationValidUntil);
    if (checkedAt > submittedAt || submittedAt >= validationValidUntil) return fail();
    return Object.freeze({
      profile: "DigitalReceiptTemplateSubmissionV1",
      tenantReference: ref(r.tenantReference),
      brandReference: ref(r.brandReference),
      storeReference: ref(r.storeReference),
      templateReference: ref(r.templateReference),
      familyReference: ref(r.familyReference),
      versionReference: ref(r.versionReference),
      draftRevision: positive(r.draftRevision),
      contentDigest: hash(r.contentDigest),
      authoredByReference: ref(r.authoredByReference),
      submittedByReference: ref(r.submittedByReference),
      operationReference: ref(r.operationReference),
      reviewLifecycleReference: ref(r.reviewLifecycleReference),
      reviewVersion: positive(r.reviewVersion, 2),
      validationEvidenceReference: ref(r.validationEvidenceReference),
      checkedAt,
      validationValidUntil,
      submittedAt,
      auditReference: ref(r.auditReference),
      dataClassification: "Internal",
    });
  });
}
export function parseReceiptTemplateReviewCurrent(
  v: unknown,
  store: string,
  template: string,
  expectedScope?: StoreSetupScope,
): ReceiptTemplateReviewCurrent {
  return safe(() => {
    const r = record(v, [
        "profile",
        ...scopeKeys,
        "templateReference",
        "currentDraft",
        "submission",
        "lifecycle",
        "observedAt",
        "validUntil",
        "sourceQualification",
      ]),
      scope = scopeFrom(r);
    if (
      scope.storeReference !== ref(store) ||
      (expectedScope && !sameScope(scope, parseStoreSetupScope(expectedScope)))
    )
      return fail("ScopeChanged");
    if (
      r.profile !== "DigitalReceiptTemplateReviewCurrentV1" ||
      r.sourceQualification !== "NotEvaluated" ||
      r.templateReference !== ref(template)
    )
      return fail();
    const observedAt = instant(r.observedAt),
      validUntil = instant(r.validUntil);
    if (validUntil <= observedAt || Date.parse(validUntil) - Date.parse(observedAt) > 5000)
      return fail();
    const d = record(r.currentDraft, ["versionReference", "revision", "contentDigest"]),
      currentDraft = Object.freeze({
        versionReference: ref(d.versionReference),
        revision: positive(d.revision),
        contentDigest: hash(d.contentDigest),
      });
    const submission = r.submission === null ? null : parseReceiptTemplateSubmission(r.submission);
    let lifecycle: ReceiptTemplateReviewCurrent["lifecycle"] = null;
    if ((submission === null) !== (r.lifecycle === null)) return fail();
    if (submission) {
      const l = record(r.lifecycle, [
        "lifecycleReference",
        "version",
        "state",
        "latestMutationOperationReference",
        "changedAt",
        "validationEvidenceReference",
        "approvalEvidenceReference",
      ]);
      if (
        l.state !== "InReview" &&
        l.state !== "Approved" &&
        l.state !== "Published" &&
        l.state !== "Archived"
      )
        return fail();
      lifecycle = Object.freeze({
        lifecycleReference: ref(l.lifecycleReference),
        version: positive(l.version),
        state: l.state,
        latestMutationOperationReference: ref(l.latestMutationOperationReference),
        changedAt: instant(l.changedAt),
        validationEvidenceReference: ref(l.validationEvidenceReference),
        approvalEvidenceReference:
          l.approvalEvidenceReference === null ? null : ref(l.approvalEvidenceReference),
      });
      if (
        submission.tenantReference !== scope.tenantReference ||
        submission.brandReference !== scope.brandReference ||
        submission.storeReference !== scope.storeReference ||
        submission.templateReference !== template ||
        submission.submittedAt > observedAt ||
        lifecycle.lifecycleReference !== submission.reviewLifecycleReference ||
        lifecycle.version < submission.reviewVersion ||
        lifecycle.validationEvidenceReference !== submission.validationEvidenceReference ||
        lifecycle.changedAt < submission.submittedAt ||
        lifecycle.changedAt > observedAt
      )
        return fail();
      if (
        lifecycle.state === "InReview" &&
        (lifecycle.version !== submission.reviewVersion ||
          lifecycle.latestMutationOperationReference !== submission.operationReference ||
          lifecycle.changedAt !== submission.submittedAt ||
          lifecycle.approvalEvidenceReference !== null)
      )
        return fail();
      if (lifecycle.state !== "InReview" && lifecycle.version <= submission.reviewVersion)
        return fail();
      if (
        currentDraft.revision < submission.draftRevision ||
        (currentDraft.versionReference === submission.versionReference &&
          (currentDraft.revision !== submission.draftRevision ||
            currentDraft.contentDigest !== submission.contentDigest)) ||
        (currentDraft.revision === submission.draftRevision &&
          currentDraft.versionReference !== submission.versionReference)
      )
        return fail();
    }
    return Object.freeze({
      profile: "DigitalReceiptTemplateReviewCurrentV1",
      ...scope,
      templateReference: ref(template),
      currentDraft,
      submission,
      lifecycle,
      observedAt,
      validUntil,
      sourceQualification: "NotEvaluated",
    });
  });
}
export async function validateReceiptTemplateSubmitReceipt(
  v: unknown,
  input: ReceiptTemplateSubmitCursor,
): Promise<ReceiptTemplateSubmitReceipt> {
  const c = parseReceiptTemplateSubmitCursor(input);
  if (
    (await publicationValueDigest(
      original({
        profile: "DigitalReceiptTemplateSubmitV1",
        ...c.scope,
        operationReference: c.operationReference,
        templateReference: c.templateReference,
        expectedVersionReference: c.expectedVersionReference,
        expectedRevision: c.expectedRevision,
        purposeCode: "RECEIPT_TEMPLATE_REVIEW",
      }),
    )) !== c.intentDigest
  )
    return fail();
  return safe(() => {
    const r = record(v, [
        "profile",
        ...scopeKeys,
        "operationReference",
        "templateReference",
        "expectedVersionReference",
        "expectedRevision",
        "intentDigest",
        "outcome",
        "submission",
        "auditReference",
        "occurredAt",
      ]),
      scope = scopeFrom(r);
    if (!sameScope(scope, c.scope)) return fail("ScopeChanged");
    if (
      r.profile !== "DigitalReceiptTemplateSubmitReceiptV1" ||
      r.operationReference !== c.operationReference ||
      r.templateReference !== c.templateReference ||
      r.expectedVersionReference !== c.expectedVersionReference ||
      r.expectedRevision !== c.expectedRevision ||
      r.intentDigest !== c.intentDigest ||
      (r.outcome !== "Committed" && r.outcome !== "Abandoned")
    )
      return fail();
    const submission = r.submission === null ? null : parseReceiptTemplateSubmission(r.submission),
      occurredAt = instant(r.occurredAt),
      auditReference = ref(r.auditReference);
    if ((r.outcome === "Abandoned") !== (submission === null)) return fail();
    if (
      submission &&
      (submission.tenantReference !== scope.tenantReference ||
        submission.brandReference !== scope.brandReference ||
        submission.storeReference !== scope.storeReference ||
        submission.operationReference !== c.operationReference ||
        submission.templateReference !== c.templateReference ||
        submission.versionReference !== c.expectedVersionReference ||
        submission.draftRevision !== c.expectedRevision ||
        submission.submittedByReference !== scope.actorReference ||
        submission.auditReference !== auditReference ||
        submission.submittedAt !== occurredAt)
    )
      return fail();
    return Object.freeze({
      profile: "DigitalReceiptTemplateSubmitReceiptV1",
      ...scope,
      ...pins(r),
      intentDigest: c.intentDigest,
      outcome: r.outcome,
      submission,
      auditReference,
      occurredAt,
    });
  });
}
interface RequestOptions {
  readonly csrf?: string;
  readonly signal?: AbortSignal;
}

export function createReceiptTemplateSubmitClient(fetcher: typeof fetch = fetch) {
  let key = "",
    epoch = 0;
  const request = async (
    store: string,
    scope: StoreSetupScope | undefined,
    options: RequestOptions,
    body?: unknown,
    subject?: string | null,
  ) => {
    const csrf = options.csrf,
      signal = options.signal;
    const current = canonical({
      store,
      subject: subject ?? null,
      scope: scope ?? null,
      csrf: options.csrf,
    });
    if (current !== key) {
      key = current;
      epoch++;
    }
    const captured = epoch;
    if (
      body !== undefined &&
      (typeof options.csrf !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(options.csrf))
    )
      return fail();
    if (options.signal?.aborted) return fail("Unavailable");
    const controller = new AbortController(),
      abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 15000);
    let sent = false;
    try {
      const encoded = body === undefined ? undefined : canonical(body);
      if (encoded !== undefined && new TextEncoder().encode(encoded).length > 16384) return fail();
      sent = true;
      const response = await fetcher(
        `/merchant/store-setup/receipt-template-${body === undefined ? "review" : "submit"}${body === undefined ? `?storeReference=${ref(store)}&templateReference=${ref(subject)}` : ""}`,
        {
          method: body === undefined ? "GET" : "POST",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            ...(options.csrf ? { "X-BOP-CSRF": options.csrf } : {}),
            ...(scope
              ? {
                  "X-BOP-Store-Setup-Scope": btoa(canonical(scope))
                    .replace(/\+/gu, "-")
                    .replace(/\//gu, "_")
                    .replace(/=+$/u, ""),
                }
              : {}),
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(encoded === undefined ? {} : { body: encoded }),
        },
      );
      if (captured !== epoch || options.csrf !== csrf || options.signal !== signal)
        return fail("ScopeChanged");
      if (controller.signal.aborted) return fail(body ? "OutcomeUnknown" : "Unavailable");
      if (response.status === 403) return fail("Denied");
      if (response.status === 409) return fail("Conflict");
      if (response.status === 400) return fail("Invalid");
      if (
        !response.ok ||
        response.headers.get("cache-control") !== "no-store" ||
        !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
      )
        return fail(body ? "OutcomeUnknown" : "Unavailable");
      if (!response.body) return fail(body ? "OutcomeUnknown" : "Unavailable");
      const reader = response.body.getReader(),
        decoder = new TextDecoder("utf-8", { fatal: true });
      const cancel = () => {
        void reader.cancel().catch(() => undefined);
      };
      controller.signal.addEventListener("abort", cancel, { once: true });
      let bytes = 0,
        text = "";
      try {
        if (controller.signal.aborted) cancel();
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 32768) return fail(body ? "OutcomeUnknown" : "Unavailable");
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        controller.signal.removeEventListener("abort", cancel);
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      if (controller.signal.aborted) return fail(body ? "OutcomeUnknown" : "Unavailable");
      if (captured !== epoch || options.csrf !== csrf || options.signal !== signal)
        return fail("ScopeChanged");
      return JSON.parse(text) as unknown;
    } catch (error) {
      if (error instanceof StoreSetupClientError) throw error;
      return fail(body && sent ? "OutcomeUnknown" : "Unavailable");
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  };
  const active = (
    e: number,
    options: RequestOptions,
    csrf: string | undefined,
    signal: AbortSignal | undefined,
    mutated = false,
  ) => {
    if (e !== epoch || options.csrf !== csrf || options.signal !== signal)
      return fail("ScopeChanged");
    if (signal?.aborted) return fail(mutated ? "OutcomeUnknown" : "Unavailable");
  };
  const checkDigest = async (c: ReceiptTemplateSubmitCursor) => {
    if (
      (await publicationValueDigest(
        original({
          profile: "DigitalReceiptTemplateSubmitV1",
          ...c.scope,
          operationReference: c.operationReference,
          templateReference: c.templateReference,
          expectedVersionReference: c.expectedVersionReference,
          expectedRevision: c.expectedRevision,
          purposeCode: "RECEIPT_TEMPLATE_REVIEW",
        }),
      )) !== c.intentDigest
    )
      return fail();
  };
  const terminal = async (
    raw: unknown,
    c: ReceiptTemplateSubmitCursor,
    e: number,
    options: RequestOptions,
    csrf: string | undefined,
    signal: AbortSignal | undefined,
  ) => {
    try {
      active(e, options, csrf, signal, true);
      const receipt = await validateReceiptTemplateSubmitReceipt(raw, c);
      active(e, options, csrf, signal, true);
      return receipt;
    } catch (error) {
      if (error instanceof StoreSetupClientError && error.code === "ScopeChanged") throw error;
      return fail("OutcomeUnknown");
    }
  };
  return Object.freeze({
    async load(
      input: RequestOptions & {
        storeReference: string;
        templateReference: string;
        expectedScope?: StoreSetupScope;
      },
    ) {
      const csrf = input.csrf,
        signal = input.signal,
        store = safe(() => ref(input.storeReference)),
        subject = safe(() => ref(input.templateReference)),
        scope = input.expectedScope ? parseStoreSetupScope(input.expectedScope) : undefined;
      const result = parseReceiptTemplateReviewCurrent(
        await request(store, scope, input, undefined, subject),
        store,
        subject,
        scope,
      );
      if (
        input.storeReference !== store ||
        input.templateReference !== subject ||
        canonical(input.expectedScope ? parseStoreSetupScope(input.expectedScope) : null) !==
          canonical(scope ?? null)
      )
        return fail("ScopeChanged");
      active(epoch, input, csrf, signal);
      if (Date.now() < Date.parse(result.observedAt) || Date.now() >= Date.parse(result.validUntil))
        return fail("Stale");
      return result;
    },
    async prepare(input: {
      expectedScope: StoreSetupScope;
      operationReference: string;
      templateReference: string;
      expectedVersionReference: string;
      expectedRevision: number;
    }): Promise<PreparedReceiptTemplateSubmit> {
      const r = safe(() =>
          record(input, [
            "expectedScope",
            "operationReference",
            "templateReference",
            "expectedVersionReference",
            "expectedRevision",
          ]),
        ),
        scope = parseStoreSetupScope(r.expectedScope),
        command = safe(() =>
          original({
            profile: "DigitalReceiptTemplateSubmitV1",
            ...scope,
            ...pins(r),
            purposeCode: "RECEIPT_TEMPLATE_REVIEW",
          }),
        );
      const intentDigest = await publicationValueDigest(command),
        cursor = parseReceiptTemplateSubmitCursor({
          profile: "ReceiptTemplateSubmitPendingOriginalV1",
          scope,
          ...pins({ ...command }),
          intentDigest,
        });
      return Object.freeze({ command, intentDigest, cursor });
    },
    async execute(
      input: PreparedReceiptTemplateSubmit,
      options: RequestOptions & { csrf: string },
    ) {
      const csrf = options.csrf,
        signal = options.signal,
        e = epoch;
      active(e, options, csrf, signal);
      const r = safe(() => record(input, ["command", "cursor", "intentDigest"])),
        command = original(r.command),
        cursor = parseReceiptTemplateSubmitCursor(r.cursor);
      if (
        !sameScope(scopeFrom({ ...command }), cursor.scope) ||
        canonical(pins({ ...command })) !== canonical(pins({ ...cursor })) ||
        r.intentDigest !== cursor.intentDigest
      )
        return fail();
      await checkDigest(cursor);
      active(e, options, csrf, signal);
      const raw = await request(
        cursor.scope.storeReference,
        cursor.scope,
        options,
        { command: "SubmitReview", ...pins({ ...cursor }) },
        cursor.templateReference,
      );
      return terminal(raw, cursor, epoch, options, csrf, signal);
    },
    async resolve(input: ReceiptTemplateSubmitCursor, options: RequestOptions & { csrf: string }) {
      const csrf = options.csrf,
        signal = options.signal,
        e = epoch,
        cursor = parseReceiptTemplateSubmitCursor(input);
      active(e, options, csrf, signal);
      await checkDigest(cursor);
      active(e, options, csrf, signal);
      const raw = await request(
        cursor.scope.storeReference,
        cursor.scope,
        options,
        { command: "ResolveOriginal", ...pins({ ...cursor }), intentDigest: cursor.intentDigest },
        cursor.templateReference,
      );
      return terminal(raw, cursor, epoch, options, csrf, signal);
    },
  });
}
