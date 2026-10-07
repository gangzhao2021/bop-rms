import {
  validateStoreConfigurationOriginalCursor,
  validateStoreConfigurationOrdinaryReceipt,
  parseStoreConfigurationOrdinaryWorkspace,
  type StoreConfigurationOriginalCursor,
  type StoreConfigurationOrdinaryHead,
  type StoreConfigurationSetupSelector,
  type StoreConfigurationOrdinaryReceipt,
  type StoreConfigurationOrdinaryWorkspace,
} from "./store-configuration-pending-journal.js";
import {
  parseStoreSetupScope,
  StoreSetupClientError,
  type StoreSetupScope,
} from "./store-setup-client.js";
import {
  copyProductCommandValue,
  productCommandRecord as record,
  parseCatalogReference,
  parseCatalogInstant,
} from "./catalog-product-command-values.js";
import {
  canonicalPublicationValue as canonical,
  publicationValueDigest,
} from "./product-publication-command-client-v2.js";
import {
  parseStoreConfigurationSnapshot,
  type StoreConfigurationSnapshot,
} from "./store-configuration-client.js";
export type StoreConfigurationOrdinaryCommand = Readonly<
  StoreSetupScope & {
    readonly profile: "StoreConfigurationOrdinaryCommandV1";
    readonly operationReference: string;
    readonly expectedHead: StoreConfigurationOrdinaryHead;
  } & (
      | {
          readonly action: "Materialize";
          readonly setupSelector: StoreConfigurationSetupSelector;
          readonly reasonCode: string;
        }
      | { readonly action: "Validate" | "Submit" | "Approve" | "Publish" }
    )
>;
export interface PreparedStoreConfigurationOrdinaryCommand {
  readonly command: StoreConfigurationOrdinaryCommand;
  readonly cursor: StoreConfigurationOriginalCursor;
  readonly intentDigest: string;
}
interface ReadOptions {
  readonly signal?: AbortSignal;
}
interface WriteOptions extends ReadOptions {
  readonly csrf: string;
}
const fail = (code: StoreSetupClientError["code"] = "Invalid"): never => {
  throw new StoreSetupClientError(code);
};
const safe = <T>(work: () => T): T => {
  try {
    return work();
  } catch (error) {
    if (error instanceof StoreSetupClientError) throw error;
    return fail();
  }
};
function scopeOf(value: unknown): StoreSetupScope {
  return safe(() => {
    const copied = copyProductCommandValue(value);
    if (!copied || typeof copied !== "object" || Array.isArray(copied)) return fail();
    const r = copied as Record<string, unknown>;
    return parseStoreSetupScope({
      tenantReference: r.tenantReference,
      brandReference: r.brandReference,
      storeReference: r.storeReference,
      actorReference: r.actorReference,
    });
  });
}
function commandFrom(cursor: StoreConfigurationOriginalCursor): StoreConfigurationOrdinaryCommand {
  const base = {
    profile: "StoreConfigurationOrdinaryCommandV1" as const,
    ...scopeOf(cursor),
    operationReference: cursor.operationReference,
    expectedHead: cursor.expectedHead,
  };
  return cursor.action === "Materialize"
    ? Object.freeze({
        ...base,
        action: cursor.action,
        setupSelector: cursor.setupSelector,
        reasonCode: cursor.reasonCode,
      })
    : Object.freeze({ ...base, action: cursor.action });
}
function controls(value: ReadOptions | WriteOptions, write: boolean) {
  return safe(() => {
    const r = record(value, write ? ["csrf"] : [], ["signal"]);
    if (write && (typeof r.csrf !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(r.csrf)))
      return fail();
    if (r.signal !== undefined && !(r.signal instanceof AbortSignal)) return fail();
    return {
      csrf: write ? (r.csrf as string) : undefined,
      signal: r.signal as AbortSignal | undefined,
    };
  });
}
export interface StoreConfigurationOrdinaryHistoryEntry {
  readonly sequenceNumber: number;
  readonly operationReference: string;
  readonly command: "SaveDraft" | "Validate" | "Submit" | "Approve" | "Publish";
  readonly configuration: StoreConfigurationSnapshot;
  readonly intentDigest: string;
  readonly actorReference: string;
  readonly purposeCode: string;
  readonly auditReference: string;
  readonly occurredAt: string;
  readonly expectedVersion: number;
}
export interface StoreConfigurationOrdinaryHistory {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly readerActorReference: string;
  readonly beforeSequence: number | null;
  readonly entries: readonly StoreConfigurationOrdinaryHistoryEntry[];
  readonly nextBeforeSequence: number | null;
  readonly observedAt: string;
  readonly validUntil: string;
}
const sequence = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fail();
function historyCopy(value: unknown): unknown {
  let remaining = 250000,
    textRemaining = 4202496;
  const visit = (v: unknown, depth: number): unknown => {
    if (--remaining < 0 || depth > 20) return fail();
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") return Number.isFinite(v) ? v : fail();
    if (typeof v === "string") {
      textRemaining -= new TextEncoder().encode(v).byteLength;
      return textRemaining >= 0 && v.length <= 4096 ? v : fail();
    }
    if (!v || typeof v !== "object") return fail();
    if (Array.isArray(v)) {
      if (
        Object.getPrototypeOf(v) !== Array.prototype ||
        v.length > 10000 ||
        Reflect.ownKeys(v).length !== v.length + 1
      )
        return fail();
      return Array.from({ length: v.length }, (_, i) => {
        const d = Object.getOwnPropertyDescriptor(v, String(i));
        return d?.enumerable && "value" in d ? visit(d.value, depth + 1) : fail();
      });
    }
    if (Object.getPrototypeOf(v) !== Object.prototype || Reflect.ownKeys(v).length > 64)
      return fail();
    return Object.fromEntries(
      Reflect.ownKeys(v).map((k) => {
        const d = Object.getOwnPropertyDescriptor(v, k);
        return typeof k === "string" && d?.enumerable && "value" in d
          ? [k, visit(d.value, depth + 1)]
          : fail();
      }),
    );
  };
  return visit(value, 0);
}
/** Immutable operation history is distinct from current head and original recovery.
 * Stored 005 intent hashes have no browser preimage and are never recomputed here. */
export function parseStoreConfigurationOrdinaryHistory(
  value: unknown,
  expectedScope: StoreSetupScope,
  beforeSequence: number | null,
): StoreConfigurationOrdinaryHistory {
  return safe(() => {
    const copied = historyCopy(value);
    if (new TextEncoder().encode(canonical(copied)).byteLength > 4202496) return fail();
    const r = record(copied, [
      "tenantReference",
      "brandReference",
      "storeReference",
      "readerActorReference",
      "beforeSequence",
      "entries",
      "nextBeforeSequence",
      "observedAt",
      "validUntil",
    ]);
    const scope = parseStoreSetupScope({
      tenantReference: r.tenantReference,
      brandReference: r.brandReference,
      storeReference: r.storeReference,
      actorReference: r.readerActorReference,
    });
    if (canonical(scope) !== canonical(parseStoreSetupScope(expectedScope)))
      return fail("ScopeChanged");
    if (beforeSequence !== null) sequence(beforeSequence);
    if (r.beforeSequence !== beforeSequence || !Array.isArray(r.entries) || r.entries.length > 2)
      return fail();
    const observedAt = parseCatalogInstant(r.observedAt),
      validUntil = parseCatalogInstant(r.validUntil),
      now = Date.now();
    if (
      observedAt >= validUntil ||
      Date.parse(validUntil) - Date.parse(observedAt) > 5000 ||
      now < Date.parse(observedAt) ||
      now >= Date.parse(validUntil)
    )
      return fail("Stale");
    const entries = r.entries.map((raw) => {
      const e = record(raw, [
        "sequenceNumber",
        "operationReference",
        "command",
        "configuration",
        "intentDigest",
        "actorReference",
        "purposeCode",
        "auditReference",
        "occurredAt",
        "expectedVersion",
      ]);
      const configuration = parseStoreConfigurationSnapshot(e.configuration, scope.storeReference),
        occurredAt = parseCatalogInstant(e.occurredAt);
      if (
        configuration.brandReference !== scope.brandReference ||
        configuration.storeReference !== scope.storeReference ||
        (configuration.setupBasis &&
          configuration.setupBasis.tenantReference !== scope.tenantReference)
      )
        return fail("ScopeChanged");
      if (
        typeof e.command !== "string" ||
        !["SaveDraft", "Validate", "Submit", "Approve", "Publish"].includes(e.command) ||
        typeof e.expectedVersion !== "number" ||
        !Number.isSafeInteger(e.expectedVersion) ||
        e.expectedVersion < 0 ||
        e.expectedVersion !==
          configuration.configurationVersion - (e.command === "SaveDraft" ? 1 : 0) ||
        configuration.lifecycle !==
          (e.command === "SaveDraft" || e.command === "Validate"
            ? "Draft"
            : e.command === "Submit"
              ? "PendingApproval"
              : e.command === "Approve"
                ? "Approved"
                : "Published") ||
        configuration.updatedAt > occurredAt ||
        configuration.createdAt > occurredAt ||
        occurredAt > observedAt ||
        typeof e.intentDigest !== "string" ||
        !/^sha256:[a-f0-9]{64}$/u.test(e.intentDigest) ||
        typeof e.purposeCode !== "string" ||
        !/^[A-Z][A-Z0-9_.:-]{0,63}$/u.test(e.purposeCode)
      )
        return fail();
      return Object.freeze({
        sequenceNumber: sequence(e.sequenceNumber),
        operationReference: parseCatalogReference(e.operationReference),
        command: e.command as StoreConfigurationOrdinaryHistoryEntry["command"],
        configuration,
        intentDigest: e.intentDigest,
        actorReference: parseCatalogReference(e.actorReference),
        purposeCode: e.purposeCode,
        auditReference: parseCatalogReference(e.auditReference),
        occurredAt,
        expectedVersion: e.expectedVersion,
      });
    });
    let previous = beforeSequence;
    const operations = new Set<string>();
    for (const e of entries) {
      if (
        (previous !== null && e.sequenceNumber >= previous) ||
        operations.has(e.operationReference)
      )
        return fail();
      previous = e.sequenceNumber;
      operations.add(e.operationReference);
    }
    // Strict descending including the second entry; the first may be MAX_SAFE_INTEGER.
    if (
      entries.length === 2 &&
      entries[0] &&
      entries[1] &&
      entries[1].sequenceNumber >= entries[0].sequenceNumber
    )
      return fail();
    const nextBeforeSequence =
      r.nextBeforeSequence === null ? null : sequence(r.nextBeforeSequence);
    if (
      nextBeforeSequence !== null &&
      (entries.length !== 2 || entries[1]?.sequenceNumber !== nextBeforeSequence)
    )
      return fail();
    if (Date.now() >= Date.parse(validUntil)) return fail("Stale");
    return Object.freeze({
      tenantReference: scope.tenantReference,
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      readerActorReference: scope.actorReference,
      beforeSequence,
      entries: Object.freeze(entries),
      nextBeforeSequence,
      observedAt,
      validUntil,
    });
  });
}
/** Actual ordinary routes share the /merchant BFF mount. No configuration body,
 * allocation metadata or original intent appears in a recovery URL. */
export function createStoreConfigurationOrdinaryClient(fetcher: typeof fetch = fetch) {
  let epoch = 0;
  function begin(rawScope: StoreSetupScope, options: ReadOptions | WriteOptions, write = false) {
    const scope = parseStoreSetupScope(rawScope),
      captured = controls(options, write),
      generation = ++epoch;
    const check = (sentWrite = false) => {
      if (generation !== epoch) return fail("ScopeChanged");
      let current: ReturnType<typeof controls>;
      try {
        current = controls(options, write);
        if (canonical(parseStoreSetupScope(rawScope)) !== canonical(scope))
          return fail("ScopeChanged");
      } catch {
        return fail("ScopeChanged");
      }
      if (current.csrf !== captured.csrf || current.signal !== captured.signal)
        return fail("ScopeChanged");
      if (captured.signal?.aborted) return fail(sentWrite ? "OutcomeUnknown" : "Unavailable");
    };
    check();
    return { scope, captured, check };
  }
  async function request(
    path: string,
    state: ReturnType<typeof begin>,
    body: unknown | undefined,
    mutating: boolean,
  ) {
    state.check();
    const controller = new AbortController(),
      abort = () => controller.abort();
    state.captured.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 15000);
    let sent = false;
    const unknown = () => fail(mutating && sent ? "OutcomeUnknown" : "Unavailable");
    try {
      const encoded = body === undefined ? undefined : canonical(body);
      if (encoded !== undefined && new TextEncoder().encode(encoded).byteLength > 8192)
        return fail();
      state.check();
      sent = true;
      const response = await fetcher(path, {
        method: body === undefined ? "GET" : "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "X-BOP-Store-Setup-Scope": btoa(canonical(state.scope))
            .replace(/\+/gu, "-")
            .replace(/\//gu, "_")
            .replace(/=+$/u, ""),
          ...(body === undefined
            ? {}
            : { "Content-Type": "application/json", "X-BOP-CSRF": state.captured.csrf ?? "" }),
        },
        ...(encoded === undefined ? {} : { body: encoded }),
      });
      state.check(mutating);
      if (controller.signal.aborted) return unknown();
      if (response.redirected) return unknown();
      if (response.url) {
        if (
          typeof globalThis.location !== "object" ||
          new URL(response.url).href !== new URL(path, globalThis.location.origin).href
        )
          return unknown();
      }
      if (response.status === 403) return fail("Denied");
      if (response.status === 409) return fail("Conflict");
      if (response.status === 400) return fail("Invalid");
      if (
        !response.ok ||
        response.headers.get("cache-control") !== "no-store" ||
        !response.headers.get("content-type")?.toLowerCase().startsWith("application/json") ||
        !response.body
      )
        return unknown();
      const reader = response.body.getReader(),
        decoder = new TextDecoder("utf-8", { fatal: true });
      const cancel = () => {
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
          if (bytes > 10485760) return unknown();
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        controller.signal.removeEventListener("abort", cancel);
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      state.check(mutating);
      if (controller.signal.aborted) return unknown();
      return JSON.parse(text) as unknown;
    } catch (error) {
      if (error instanceof StoreSetupClientError) throw error;
      return unknown();
    } finally {
      clearTimeout(timer);
      state.captured.signal?.removeEventListener("abort", abort);
    }
  }
  async function terminal(
    raw: unknown,
    cursor: StoreConfigurationOriginalCursor,
    state: ReturnType<typeof begin>,
  ): Promise<StoreConfigurationOrdinaryReceipt> {
    try {
      state.check(true);
      const receipt = await validateStoreConfigurationOrdinaryReceipt(raw);
      state.check(true);
      if (
        canonical(
          parseStoreSetupScope({
            tenantReference: receipt.tenantReference,
            brandReference: receipt.brandReference,
            storeReference: receipt.storeReference,
            actorReference: receipt.actorReference,
          }),
        ) !== canonical(state.scope)
      )
        return fail("ScopeChanged");
      const bound = await validateStoreConfigurationOrdinaryReceipt(receipt, cursor);
      state.check(true);
      if (bound.occurredAt > new Date(Date.now()).toISOString()) return fail("OutcomeUnknown");
      return bound;
    } catch (error) {
      if (error instanceof StoreSetupClientError && error.code === "ScopeChanged") throw error;
      return fail("OutcomeUnknown");
    }
  }
  return Object.freeze({
    invalidate() {
      epoch++;
    },
    async load(
      scope: StoreSetupScope,
      options: ReadOptions = {},
    ): Promise<StoreConfigurationOrdinaryWorkspace> {
      const state = begin(scope, options),
        raw = await request(
          `/merchant/store-configuration/ordinary?expectedStoreReference=${state.scope.storeReference}`,
          state,
          undefined,
          false,
        );
      const workspace = await parseStoreConfigurationOrdinaryWorkspace(raw, state.scope);
      state.check();
      return workspace;
    },
    async history(
      scope: StoreSetupScope,
      options: WriteOptions & { readonly beforeSequence: number | null },
    ): Promise<StoreConfigurationOrdinaryHistory> {
      const r = safe(() => record(options, ["csrf", "beforeSequence"], ["signal"]));
      const beforeSequence = r.beforeSequence === null ? null : sequence(r.beforeSequence);
      // Preserve caller control identity without passing selector keys to controls().
      const controlsValue = {
        csrf: r.csrf as string,
        ...(r.signal === undefined ? {} : { signal: r.signal as AbortSignal }),
      };
      const state = begin(scope, controlsValue, true);
      const selectorCheck = () => {
        const current = safe(() => record(options, ["csrf", "beforeSequence"], ["signal"]));
        if (
          current.csrf !== r.csrf ||
          current.signal !== r.signal ||
          current.beforeSequence !== beforeSequence
        )
          return fail("ScopeChanged");
      };
      selectorCheck();
      const raw = await request(
        "/merchant/store-configuration/ordinary-history",
        state,
        { expectedStoreReference: state.scope.storeReference, beforeSequence },
        false,
      );
      selectorCheck();
      const page = parseStoreConfigurationOrdinaryHistory(raw, state.scope, beforeSequence);
      state.check();
      return page;
    },
    async prepare(
      value: StoreConfigurationOrdinaryCommand,
      options: ReadOptions = {},
    ): Promise<PreparedStoreConfigurationOrdinaryCommand> {
      const detached = safe(() => copyProductCommandValue(value));
      const scope = scopeOf(detached),
        state = begin(scope, options);
      if (
        !detached ||
        typeof detached !== "object" ||
        Array.isArray(detached) ||
        Object.getOwnPropertyDescriptor(detached, "profile")?.value !==
          "StoreConfigurationOrdinaryCommandV1"
      )
        return fail();
      if (new TextEncoder().encode(canonical(detached)).byteLength > 8192) return fail();
      const intentDigest = await publicationValueDigest(detached);
      state.check();
      const cursor = await validateStoreConfigurationOriginalCursor({
        ...detached,
        profile: "StoreConfigurationOrdinaryResolveV1",
        intentDigest,
      });
      state.check();
      return Object.freeze({ command: commandFrom(cursor), cursor, intentDigest });
    },
    async execute(
      value: PreparedStoreConfigurationOrdinaryCommand,
      options: WriteOptions,
    ): Promise<StoreConfigurationOrdinaryReceipt> {
      const r = safe(() =>
          record(copyProductCommandValue(value), ["command", "cursor", "intentDigest"]),
        ),
        scope = scopeOf(r.command),
        state = begin(scope, options, true);
      const cursor = await validateStoreConfigurationOriginalCursor(r.cursor);
      state.check();
      if (
        canonical(scopeOf(cursor)) !== canonical(state.scope) ||
        r.intentDigest !== cursor.intentDigest ||
        canonical(r.command) !== canonical(commandFrom(cursor))
      )
        return fail();
      const raw = await request(
        "/merchant/store-configuration/ordinary-command",
        state,
        { command: commandFrom(cursor) },
        true,
      );
      return terminal(raw, cursor, state);
    },
    async resolve(
      value: StoreConfigurationOriginalCursor,
      options: WriteOptions,
    ): Promise<StoreConfigurationOrdinaryReceipt> {
      const scope = scopeOf(value),
        state = begin(scope, options, true),
        cursor = await validateStoreConfigurationOriginalCursor(value);
      state.check();
      const raw = await request(
        "/merchant/store-configuration/ordinary-command",
        state,
        { command: cursor },
        true,
      );
      return terminal(raw, cursor, state);
    },
    async refreshOriginal(
      value: StoreConfigurationOriginalCursor,
      options: WriteOptions,
    ): Promise<StoreConfigurationOrdinaryWorkspace> {
      const scope = scopeOf(value),
        state = begin(scope, options, true),
        cursor = await validateStoreConfigurationOriginalCursor(value);
      state.check();
      const raw = await request(
        "/merchant/store-configuration/ordinary-state",
        state,
        { original: cursor, expectedStoreReference: state.scope.storeReference },
        false,
      );
      const workspace = await parseStoreConfigurationOrdinaryWorkspace(raw, state.scope);
      state.check();
      if (workspace.original === null) return fail("Unavailable");
      await validateStoreConfigurationOrdinaryReceipt(workspace.original, cursor);
      state.check();
      return workspace;
    },
  });
}
