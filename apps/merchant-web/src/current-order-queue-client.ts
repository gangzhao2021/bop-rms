export class CurrentOrderQueueError extends Error {
  constructor(readonly code: "PermissionDenied" | "Unavailable") {
    super("Current orders could not be loaded");
    this.name = "CurrentOrderQueueError";
  }
}
const fail = (): never => {
  throw new CurrentOrderQueueError("Unavailable");
};
const ref = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function reference(value: unknown): string {
  if (typeof value !== "string" || !ref.test(value)) return fail();
  return value;
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail();
  return Object.fromEntries(
    keys.map((key) => {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d || !("value" in d) || !d.enumerable) return fail();
      return [key, d.value as unknown];
    }),
  );
}
function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    return fail();
  return value;
}
export function parseCurrentOrderQueue(value: unknown, after: string | null = null) {
  const raw = exact(value, ["items", "nextAfterOrderReference"]);
  if (!Array.isArray(raw.items) || raw.items.length > 50) return fail();
  let previous = after;
  const items = raw.items.map((value) => {
    const item = exact(value, [
      "orderReference",
      "orderNumber",
      "orderType",
      "sourceChannel",
      "submittedAt",
      "initialBatchReference",
      "canRequestAcceptance",
      "currentPhase",
      "currentVersion",
      "observedAt",
      "batches",
    ]);
    const orderReference = reference(item.orderReference);
    if (previous !== null && orderReference <= previous) return fail();
    previous = orderReference;
    if (
      typeof item.canRequestAcceptance !== "boolean" ||
      (item.canRequestAcceptance === true &&
        (item.currentPhase !== "Submitted" || item.currentVersion !== 1)) ||
      typeof item.orderNumber !== "string" ||
      !/^[A-Z0-9][A-Z0-9-]{0,39}$/.test(item.orderNumber) ||
      (item.orderType !== "DineIn" && item.orderType !== "Pickup") ||
      !["Api", "Pos", "Qr", "Web"].includes(String(item.sourceChannel)) ||
      (item.currentPhase !== null &&
        ![
          "Submitted",
          "Accepted",
          "InProgress",
          "Ready",
          "Rejected",
          "Cancelled",
          "Fulfilled",
        ].includes(String(item.currentPhase))) ||
      (item.currentPhase === null) !== (item.currentVersion === null) ||
      (item.currentVersion !== null &&
        (typeof item.currentVersion !== "number" ||
          !Number.isInteger(item.currentVersion) ||
          item.currentVersion < 1 ||
          item.currentVersion > 2147483647))
    )
      return fail();
    const submittedAt = instant(item.submittedAt),
      observedAt = instant(item.observedAt);
    if (observedAt < submittedAt) return fail();
    if (!Array.isArray(item.batches) || item.batches.length > 10000) return fail();
    const seenBatches = new Set<string>();
    let previousSequence = 0;
    const batches = item.batches.map((value) => {
      const batch = exact(value, [
        "orderBatchReference",
        "sequence",
        "acceptanceStatus",
        "canRequestAcceptance",
      ]);
      const orderBatchReference = reference(batch.orderBatchReference);
      if (
        typeof batch.sequence !== "number" ||
        !Number.isSafeInteger(batch.sequence) ||
        batch.sequence <= previousSequence ||
        seenBatches.has(orderBatchReference) ||
        (batch.sequence === 1) !== (orderBatchReference === item.initialBatchReference) ||
        !["Accepted", "NotAccepted", "Cancelled"].includes(String(batch.acceptanceStatus)) ||
        typeof batch.canRequestAcceptance !== "boolean" ||
        (batch.canRequestAcceptance &&
          (batch.acceptanceStatus !== "NotAccepted" ||
            item.currentVersion === null ||
            !["Submitted", "Accepted", "InProgress", "Ready"].includes(String(item.currentPhase)) ||
            (batch.sequence === 1 &&
              (item.currentVersion !== 1 || item.currentPhase !== "Submitted"))))
      )
        return fail();
      previousSequence = batch.sequence;
      seenBatches.add(orderBatchReference);
      return Object.freeze({
        orderBatchReference,
        sequence: batch.sequence,
        acceptanceStatus: batch.acceptanceStatus as "Accepted" | "NotAccepted" | "Cancelled",
        canRequestAcceptance: batch.canRequestAcceptance,
      });
    });
    if (
      item.currentVersion !== null &&
      batches[0]?.sequence !== 1 &&
      !(item.currentPhase === "Cancelled" && batches.length === 0)
    )
      return fail();
    return Object.freeze({
      batches: Object.freeze(batches),
      orderReference,
      orderNumber: item.orderNumber,
      orderType: item.orderType,
      sourceChannel: item.sourceChannel as string,
      submittedAt,
      observedAt,
      initialBatchReference: reference(item.initialBatchReference),
      canRequestAcceptance: item.canRequestAcceptance,
      currentPhase: item.currentPhase as string | null,
      currentVersion: item.currentVersion as number | null,
    });
  });
  const next = raw.nextAfterOrderReference === null ? null : reference(raw.nextAfterOrderReference);
  if (next !== null && (items.length !== 50 || next !== previous)) return fail();
  return Object.freeze({ items: Object.freeze(items), nextAfterOrderReference: next });
}
export type CurrentOrderQueue = ReturnType<typeof parseCurrentOrderQueue>;
export function createCurrentOrderQueueClient(fetcher: typeof fetch = fetch) {
  return Object.freeze({
    async load(after: string | null, signal: AbortSignal) {
      if (after !== null) reference(after);
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) controller.abort();
      const timer = setTimeout(abort, 15000);
      try {
        if (controller.signal.aborted) return fail();
        const response = await fetcher(
          "/merchant/orders" + (after === null ? "" : "?after=" + encodeURIComponent(after)),
          {
            method: "GET",
            credentials: "same-origin",
            redirect: "error",
            cache: "no-store",
            signal: controller.signal,
            headers: { Accept: "application/json" },
          },
        );
        if (response.status === 401 || response.status === 403)
          throw new CurrentOrderQueueError("PermissionDenied");
        if (
          !response.ok ||
          response.headers.get("cache-control") !== "no-store" ||
          !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
        )
          return fail();
        const text = await response.text();
        if (controller.signal.aborted || text.length > 65536) return fail();
        return parseCurrentOrderQueue(JSON.parse(text) as unknown, after);
      } catch (error) {
        if (error instanceof CurrentOrderQueueError) throw error;
        return fail();
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      }
    },
  });
}
