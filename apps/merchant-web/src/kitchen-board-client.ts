import {
  KitchenBoardClientError,
  parseKitchenBoardView,
  parseKitchenRouteReference,
  parseKitchenWorkItemView,
  type KitchenBoardClient,
  type KitchenQueueSearch,
} from "./kitchen-board.js";
const fail = (): never => {
  throw new KitchenBoardClientError("Unavailable");
};
function record(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  return value as Record<string, unknown>;
}
function closedRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const raw = record(value),
    keys = Reflect.ownKeys(raw);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return fail();
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, field);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return fail();
  }
  return raw;
}
const LOCALE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|-[0-9]{3})?$/u;
const SAFE_TEXT = /^[^\p{Cc}\p{Cf}]{1,100}$/u;
function selectedOptions(value: unknown) {
  if (!Array.isArray(value) || value.length > 100) return fail();
  return value.map((candidate) => {
    const option = closedRecord(candidate, ["optionReference", "quantity", "localizedNames"]);
    parseKitchenRouteReference(option.optionReference);
    if (
      !Number.isSafeInteger(option.quantity) ||
      Number(option.quantity) < 1 ||
      Number(option.quantity) > 999
    )
      return fail();
    const names = record(option.localizedNames),
      keys = Reflect.ownKeys(names);
    if (
      keys.length < 1 ||
      keys.length > 20 ||
      keys.some((key) => typeof key !== "string" || !LOCALE.test(key))
    )
      return fail();
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(names, key);
      if (
        !descriptor ||
        !("value" in descriptor) ||
        !descriptor.enumerable ||
        typeof descriptor.value !== "string" ||
        !SAFE_TEXT.test(descriptor.value)
      )
        return fail();
    }
    const fallbackLocale = (keys as string[]).sort()[0];
    const displayName =
      names["en-CA"] ?? names.en ?? (fallbackLocale ? names[fallbackLocale] : undefined);
    if (typeof displayName !== "string" || !SAFE_TEXT.test(displayName)) return fail();
    return Object.freeze({ displayName, quantity: Number(option.quantity) });
  });
}
function item(value: unknown) {
  const raw = record(value),
    names = record(raw.localizedDisplayNames);
  const displayName = names["en-CA"] ?? names["en"] ?? Object.values(names)[0];
  return parseKitchenWorkItemView({
    workItemReference: raw.workItemReference,
    ticketReference: raw.ticketReference,
    orderReference: raw.orderReference,
    stationLabel: null,
    displayName,
    status: raw.status,
    requiredQuantity: raw.requiredQuantity,
    completedQuantity: raw.completedQuantity,
    createdAt: raw.workItemCreatedAt,
    allergenCue: "Unavailable",
    exceptionStatus: "Unavailable",
    selectedOptions: selectedOptions(raw.selectedOptions),
    execution: {
      orderItemReference: raw.orderItemReference,
      stationReference: raw.stationReference,
      ticketVersion: raw.ticketAggregateVersion,
      workItemVersion: raw.workItemVersion,
      acceptedAt: raw.acceptedAt,
      readyAt: raw.orderItemReadyAt,
    },
  });
}
/** No browser storage or query-string identifiers. Each page must share one generation. */
export function createKitchenBoardClient(options: {
  csrf: string;
  storeLabel: string;
  storeReference: string;
  fetcher?: typeof fetch;
}): KitchenBoardClient {
  const fetcher = options.fetcher ?? fetch;
  async function query(body: unknown) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(options.csrf)) return fail();
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetcher("/merchant/kitchen/query", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-BOP-CSRF": options.csrf,
        },
        body: JSON.stringify(body),
      });
      if (response.status === 401 || response.status === 403)
        throw new KitchenBoardClientError("PermissionDenied");
      if (response.status === 404) throw new KitchenBoardClientError("NotFound");
      if (response.status === 409) throw new KitchenBoardClientError("Conflict");
      if (
        !response.ok ||
        response.headers.get("cache-control") !== "no-store" ||
        !response.headers.get("content-type")?.startsWith("application/json")
      )
        return fail();
      const text = await response.text();
      if (text.length > 1048576) return fail();
      const result = record(JSON.parse(text));
      if (
        result.projectionName !== "kitchen_work_queue_v1" ||
        result.projectionVersion !== 1 ||
        result.partial !== false ||
        typeof result.stale !== "boolean" ||
        !["Fresh", "Stale"].includes(String(result.freshnessStatus))
      )
        return fail();
      if (
        result.storeReference !== options.storeReference ||
        !["Named", "Locked", "HandoverRequired", "Unavailable", "Unverified"].includes(
          String(result.operatorStatus),
        )
      )
        return fail();
      parseKitchenRouteReference(result.storeReference);
      parseKitchenRouteReference(result.projectionGenerationReference);
      return result;
    } catch (error) {
      if (error instanceof KitchenBoardClientError) throw error;
      if (error instanceof TypeError || controller.signal.aborted)
        throw new KitchenBoardClientError("Offline");
      return fail();
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    async loadQueue(search?: KitchenQueueSearch) {
      const reference = search ? parseKitchenRouteReference(search.reference) : null;
      if (search && search.kind !== "Order" && search.kind !== "Ticket") return fail();
      const items = [],
        seen = new Set<string>();
      let cursor: unknown = null,
        first: Record<string, unknown> | undefined;
      for (let page = 0; page < 4; page++) {
        const result = await query({
          kind: "List",
          filters: {
            orderReference: search?.kind === "Order" ? reference : null,
            ticketReference: search?.kind === "Ticket" ? reference : null,
            workItemReference: null,
            stationReference: null,
            status: null,
          },
          cursor,
          limit: 50,
        });
        first ??= result;
        if (result.projectionGenerationReference !== first.projectionGenerationReference)
          throw new KitchenBoardClientError("Conflict");
        if (!Array.isArray(result.items) || result.items.length > 50 || !("nextCursor" in result))
          return fail();
        for (const raw of result.items) {
          const mapped = item(raw);
          if (seen.has(mapped.workItemReference)) return fail();
          seen.add(mapped.workItemReference);
          items.push(mapped);
        }
        cursor = result.nextCursor;
        if (cursor === null)
          return parseKitchenBoardView({
            screenId: "KIT-KITCHEN-QUEUE",
            projectionName: "kitchen_work_queue_v1",
            projectionVersion: 1,
            storeLabel: options.storeLabel,
            projectedAt: first.projectedAt,
            freshnessStatus: first.stale ? "Stale" : first.freshnessStatus,
            operatorStatus: first.operatorStatus,
            items,
          });
        const next = record(cursor);
        if (
          next.projectionGenerationReference !== first.projectionGenerationReference ||
          result.items.length === 0
        )
          return fail();
        parseKitchenRouteReference(next.afterWorkItemReference);
        if (typeof next.afterCreatedAt !== "string") return fail();
      }
      return fail();
    },
    async loadWorkItem(reference) {
      const ref = parseKitchenRouteReference(reference);
      const result = await query({ kind: "Get", workItemReference: ref });
      const mapped = item(result.item);
      if (mapped.workItemReference !== ref) return fail();
      return {
        screenId: "KIT-WORK-ITEM",
        projectionName: result.projectionName,
        projectionVersion: result.projectionVersion,
        storeLabel: options.storeLabel,
        projectedAt: result.projectedAt,
        freshnessStatus: result.stale ? "Stale" : result.freshnessStatus,
        operatorStatus: result.operatorStatus,
        item: mapped,
      };
    },
  };
}
