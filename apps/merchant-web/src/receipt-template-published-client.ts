import {
  productCommandRecord as record,
  parseCatalogReference as ref,
  parseCatalogInstant as instant,
} from "./catalog-product-command-values.js";
import { canonicalPublicationValue as canonical } from "./product-publication-command-client-v2.js";
import {
  parseStoreSetupScope,
  StoreSetupClientError,
  type StoreSetupScope,
} from "./store-setup-client.js";
import {
  parseReceiptTemplatePublishedVersion,
  type ReceiptTemplatePublishedVersion,
} from "./receipt-template-lifecycle-client.js";
export interface ReceiptTemplatePublishedCurrent extends StoreSetupScope {
  readonly profile: "DigitalReceiptTemplatePublishedCurrentV1";
  readonly templateReference: string;
  readonly locale: string;
  readonly currentVersion: ReceiptTemplatePublishedVersion;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly professionalReviewStatus: "NotEvaluated";
  readonly legalConclusion: "NotEvaluated";
}
const fail = (code: StoreSetupClientError["code"] = "Invalid"): never => {
  throw new StoreSetupClientError(code);
};
function safe<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof StoreSetupClientError) throw error;
    return fail();
  }
}
const localeValue = (value: unknown) =>
  typeof value === "string" && /^[a-z]{2,3}(?:-[A-Z]{2})?$/u.test(value) ? value : fail();
export function parseReceiptTemplatePublishedCurrent(
  value: unknown,
  scopeValue: StoreSetupScope,
  templateReference: string,
  locale: string,
): ReceiptTemplatePublishedCurrent {
  return safe(() => {
    const scope = parseStoreSetupScope(scopeValue),
      subject = ref(templateReference),
      language = localeValue(locale),
      r = record(value, [
        "profile",
        "tenantReference",
        "brandReference",
        "storeReference",
        "actorReference",
        "templateReference",
        "locale",
        "currentVersion",
        "observedAt",
        "validUntil",
        "professionalReviewStatus",
        "legalConclusion",
      ]);
    const actual = parseStoreSetupScope({
      tenantReference: r.tenantReference,
      brandReference: r.brandReference,
      storeReference: r.storeReference,
      actorReference: r.actorReference,
    });
    if (canonical(actual) !== canonical(scope)) return fail("ScopeChanged");
    const version = parseReceiptTemplatePublishedVersion(r.currentVersion),
      observedAt = instant(r.observedAt),
      validUntil = instant(r.validUntil);
    if (
      r.profile !== "DigitalReceiptTemplatePublishedCurrentV1" ||
      ref(r.templateReference) !== subject ||
      r.locale !== language ||
      r.professionalReviewStatus !== "NotEvaluated" ||
      r.legalConclusion !== "NotEvaluated" ||
      validUntil <= observedAt ||
      Date.parse(validUntil) - Date.parse(observedAt) > 5000 ||
      version.templateReference !== subject ||
      version.brandReference !== scope.brandReference ||
      version.storeReference !== scope.storeReference ||
      version.locale !== language ||
      version.publishedAt > observedAt ||
      version.effectiveFrom > observedAt ||
      (version.effectiveUntil !== null && version.effectiveUntil <= observedAt)
    )
      return fail();
    return Object.freeze({
      profile: "DigitalReceiptTemplatePublishedCurrentV1",
      ...actual,
      templateReference: subject,
      locale: language,
      currentVersion: version,
      observedAt,
      validUntil,
      professionalReviewStatus: "NotEvaluated",
      legalConclusion: "NotEvaluated",
    });
  });
}
export function createReceiptTemplatePublishedClient(fetcher: typeof fetch = fetch) {
  let epoch = 0;
  const current = Object.freeze({
    /** `installed`: the receipt template the Store started with (installer-published); the
     * server finds it and proves it like any other published template (`null`: it has none). */
    async read(
      input: {
        expectedScope: StoreSetupScope;
        templateReference?: string;
        locale: string;
        signal?: AbortSignal;
      },
      installed: boolean,
    ): Promise<ReceiptTemplatePublishedCurrent | null> {
      const r = safe(() =>
        record(input, [
          "expectedScope",
          ...(installed ? [] : ["templateReference"]),
          "locale",
          ...(Object.getOwnPropertyDescriptor(input, "signal") === undefined ? [] : ["signal"]),
        ]),
      );
      const scope = parseStoreSetupScope(r.expectedScope),
        subject = installed ? null : safe(() => ref(r.templateReference)),
        language = localeValue(r.locale),
        scopeOwner = input.expectedScope,
        signal = input.signal,
        e = ++epoch;
      const active = () => {
        if (
          e !== epoch ||
          input.expectedScope !== scopeOwner ||
          canonical(parseStoreSetupScope(input.expectedScope)) !== canonical(scope) ||
          (subject === null
            ? Object.hasOwn(input, "templateReference")
            : input.templateReference !== subject) ||
          input.locale !== language ||
          input.signal !== signal
        )
          return fail("ScopeChanged");
        if (signal?.aborted) return fail("Unavailable");
      };
      active();
      const controller = new AbortController(),
        abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, 15000);
      try {
        const query = new URLSearchParams({
          storeReference: scope.storeReference,
          ...(subject === null ? { installed: "true" } : { templateReference: subject }),
          locale: language,
        });
        const response = await fetcher(
          `/merchant/store-setup/receipt-template-published?${query}`,
          {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
            signal: controller.signal,
            headers: {
              Accept: "application/json",
              "X-BOP-Store-Setup-Scope": btoa(canonical(scope))
                .replace(/\+/gu, "-")
                .replace(/\//gu, "_")
                .replace(/=+$/u, ""),
            },
          },
        );
        active();
        if (controller.signal.aborted) return fail("Unavailable");
        // The Store has no installer-published receipt template (nothing to go back to).
        if (subject === null && response.status === 404) return null;
        if (response.status === 403) return fail("Denied");
        if (response.status === 409) return fail("Conflict");
        if (response.status === 400) return fail("Invalid");
        if (
          !response.ok ||
          response.headers.get("cache-control") !== "no-store" ||
          !response.headers.get("content-type")?.toLowerCase().startsWith("application/json") ||
          !response.body
        )
          return fail("Unavailable");
        const reader = response.body.getReader(),
          decoder = new TextDecoder("utf-8", { fatal: true }),
          cancel = () => {
            void reader.cancel().catch(() => undefined);
          };
        controller.signal.addEventListener("abort", cancel, { once: true });
        let bytes = 0,
          text = "";
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 32768) return fail("Unavailable");
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          controller.signal.removeEventListener("abort", cancel);
          void reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
        active();
        if (controller.signal.aborted) return fail("Unavailable");
        const raw: unknown = JSON.parse(text);
        const parsed = parseReceiptTemplatePublishedCurrent(
          raw,
          scope,
          subject ??
            safe(() =>
              ref(
                raw !== null && typeof raw === "object"
                  ? Object.getOwnPropertyDescriptor(raw, "templateReference")?.value
                  : undefined,
              ),
            ),
          language,
        );
        active();
        if (
          Date.now() < Date.parse(parsed.observedAt) ||
          Date.now() >= Date.parse(parsed.validUntil)
        )
          return fail("Stale");
        return parsed;
      } catch (error) {
        if (error instanceof StoreSetupClientError) throw error;
        return fail("Unavailable");
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    },
  });
  return Object.freeze({
    async load(input: {
      expectedScope: StoreSetupScope;
      templateReference: string;
      locale: string;
      signal?: AbortSignal;
    }): Promise<ReceiptTemplatePublishedCurrent> {
      return (await current.read(input, false)) ?? fail("Unavailable");
    },
    /** WP-2423 (2026-10-16): the receipt template the Store started with, as published today;
     * `null` when the Store has none. */
    async loadInstalled(input: {
      expectedScope: StoreSetupScope;
      locale: string;
      signal?: AbortSignal;
    }): Promise<ReceiptTemplatePublishedCurrent | null> {
      return current.read(input, true);
    },
  });
}
