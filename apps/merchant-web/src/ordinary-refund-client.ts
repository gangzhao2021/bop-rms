export class OrdinaryRefundClientError extends Error {
  constructor(readonly code: "Denied" | "Conflict" | "Unavailable" | "OutcomeUnknown") {
    super("Refund request could not be confirmed");
  }
}
const fail = (): never => {
  throw new OrdinaryRefundClientError("Unavailable");
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    return fail();
  return value as Record<string, unknown>;
};
const exact = (value: unknown, keys: readonly string[]) => {
  const raw = object(value);
  if (
    Reflect.ownKeys(raw).length !== keys.length ||
    keys.some((key) => {
      const property = Object.getOwnPropertyDescriptor(raw, key);
      return !property || !("value" in property) || !property.enumerable;
    })
  )
    return fail();
  return raw;
};
const ref = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  )
    return fail();
  return value;
};
const count = (value: unknown, min: number, max: number): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    return fail();
  return value;
};
const money = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,18})$/u.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    return fail();
  return value;
};
const label = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 256 ||
    Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    return fail();
  return value;
};
const components = [
  "netAmountMinor",
  "taxAmountMinor",
  "tipAmountMinor",
  "serviceChargeAmountMinor",
  "serviceChargeTaxAmountMinor",
] as const;
export interface RefundItem {
  readonly orderBatchReference: string;
  readonly orderItemReference: string;
  readonly label: string;
  readonly quantity: number;
  readonly unclaimedQuantity: number;
  readonly paymentCaptured: boolean;
  readonly paymentIntentReference: string | null;
}
export interface RefundRequestCommand {
  readonly orderReference: string;
  readonly requestReference: string;
  readonly operationReference: string;
  readonly expectedClaimVersion: number;
  readonly reasonCode: string;
  readonly items: readonly {
    readonly orderBatchReference: string;
    readonly orderItemReference: string;
    readonly quantity: number;
  }[];
}
function command(value: RefundRequestCommand) {
  const raw = exact(value, [
    "orderReference",
    "requestReference",
    "operationReference",
    "expectedClaimVersion",
    "reasonCode",
    "items",
  ]);
  if (
    typeof raw.reasonCode !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,63}$/u.test(raw.reasonCode) ||
    !Array.isArray(raw.items) ||
    raw.items.length < 1 ||
    raw.items.length > 1000
  )
    return fail();
  const items = Array.from(raw.items, (value) => {
    const item = exact(value, ["orderBatchReference", "orderItemReference", "quantity"]);
    return Object.freeze({
      orderBatchReference: ref(item.orderBatchReference),
      orderItemReference: ref(item.orderItemReference),
      quantity: count(item.quantity, 1, 999),
    });
  });
  if (
    new Set(items.map((item) => item.orderItemReference)).size !== items.length ||
    new Set(items.map((item) => item.orderBatchReference)).size > 100
  )
    return fail();
  return Object.freeze({
    orderReference: ref(raw.orderReference),
    requestReference: ref(raw.requestReference),
    operationReference: ref(raw.operationReference),
    expectedClaimVersion: count(raw.expectedClaimVersion, 0, 999),
    reasonCode: raw.reasonCode,
    items: Object.freeze(items),
  });
}
export function createOrdinaryRefundClient(fetcher: typeof fetch = fetch) {
  const send = async (
    path: string,
    body: string,
    csrf: string,
    status: number,
    signal?: AbortSignal,
  ) => {
    if (typeof csrf !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(csrf) || signal?.aborted)
      return fail();
    const controller = new AbortController(),
      abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 15000);
    try {
      const response = await fetcher(path, {
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
        },
      });
      if (controller.signal.aborted) return fail();
      if (response.status === 401 || response.status === 403)
        throw new OrdinaryRefundClientError("Denied");
      if (response.status === 409) throw new OrdinaryRefundClientError("Conflict");
      if (
        response.status !== status ||
        response.headers.get("cache-control") !== "no-store" ||
        !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
      )
        return fail();
      const text = await response.text();
      if (text.length > 300000 || controller.signal.aborted) return fail();
      return object(JSON.parse(text));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  };
  const attempts = (value: unknown) => {
    if (!Array.isArray(value) || value.length < 1 || value.length > 100) return fail();
    const parsed = value.map(ref);
    if (new Set(parsed).size !== parsed.length) return fail();
    return Object.freeze(parsed);
  };
  const boundary = async <T>(work: () => Promise<T>, mutation: boolean): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (
        error instanceof OrdinaryRefundClientError &&
        (error.code === "Denied" || error.code === "Conflict")
      )
        throw error;
      throw new OrdinaryRefundClientError(mutation ? "OutcomeUnknown" : "Unavailable");
    }
  };
  return Object.freeze({
    async context(paymentIntentReference: string, csrf: string, signal?: AbortSignal) {
      ref(paymentIntentReference);
      return boundary(async () => {
        const data = exact(
          await send(
            "/merchant/payments/refunds/context",
            JSON.stringify({ paymentIntentReference }),
            csrf,
            200,
            signal,
          ),
          [
            "paymentIntentReference",
            "paymentAttemptReference",
            "orderReference",
            "orderBatchReference",
            "observedAt",
            "paymentState",
            "currencyCode",
            "capturedAmountMinor",
            "confirmedRefundMinor",
            "pendingRefundMinor",
          ],
        );
        if (
          data.paymentIntentReference !== paymentIntentReference ||
          typeof data.observedAt !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/u.test(data.observedAt) ||
          !Number.isFinite(Date.parse(data.observedAt))
        )
          return fail();
        if (
          data.paymentState !== "Captured" &&
          data.paymentState !== "Unresolved" &&
          data.paymentState !== "Failed"
        )
          return fail();
        let capturedAmountMinor: string | null = null,
          confirmedRefundMinor: string | null = null,
          pendingRefundMinor: string | null = null;
        if (data.paymentState === "Captured") {
          if (data.currencyCode !== "CAD") return fail();
          capturedAmountMinor = money(data.capturedAmountMinor);
          confirmedRefundMinor = money(data.confirmedRefundMinor);
          pendingRefundMinor = money(data.pendingRefundMinor);
          if (
            BigInt(capturedAmountMinor) <= 0n ||
            BigInt(confirmedRefundMinor) + BigInt(pendingRefundMinor) > BigInt(capturedAmountMinor)
          )
            return fail();
        } else if (
          data.currencyCode !== null ||
          data.capturedAmountMinor !== null ||
          data.confirmedRefundMinor !== null ||
          data.pendingRefundMinor !== null
        )
          return fail();
        return Object.freeze({
          paymentIntentReference,
          paymentAttemptReference: ref(data.paymentAttemptReference),
          orderReference: ref(data.orderReference),
          orderBatchReference: ref(data.orderBatchReference),
          observedAt: data.observedAt,
          paymentState: data.paymentState,
          currencyCode: data.paymentState === "Captured" ? ("CAD" as const) : null,
          capturedAmountMinor,
          confirmedRefundMinor,
          pendingRefundMinor,
        });
      }, false);
    },
    async status(
      orderReference: string,
      operationReference: string,
      csrf: string,
      signal?: AbortSignal,
    ) {
      ref(orderReference);
      ref(operationReference);
      return boundary(async () => {
        const data = exact(
          await send(
            "/merchant/payments/refunds/status",
            JSON.stringify({ orderReference, operationReference }),
            csrf,
            200,
            signal,
          ),
          [
            "orderReference",
            "requestReference",
            "operationReference",
            "observedAt",
            "currencyCode",
            "amountMinor",
            "payments",
          ],
        );
        if (
          data.orderReference !== orderReference ||
          data.operationReference !== operationReference ||
          data.currencyCode !== "CAD" ||
          typeof data.observedAt !== "string" ||
          !Number.isFinite(Date.parse(data.observedAt)) ||
          new Date(data.observedAt).toISOString() !== data.observedAt ||
          !Array.isArray(data.payments) ||
          data.payments.length < 1 ||
          data.payments.length > 100
        )
          return fail();
        const payments = data.payments.map((value) => {
          const entry = exact(value, [
            "paymentAttemptReference",
            "paymentIntentReference",
            "state",
            "executionOperationReference",
            "amountMinor",
            "confirmedMinor",
            "pendingMinor",
          ]);
          if (
            entry.state !== "NotDispatched" &&
            entry.state !== "Prepared" &&
            entry.state !== "NeedsReconciliation" &&
            entry.state !== "Confirmed"
          )
            return fail();
          const amountMinor = money(entry.amountMinor),
            confirmedMinor = money(entry.confirmedMinor),
            pendingMinor = money(entry.pendingMinor);
          if (
            amountMinor === "0" ||
            BigInt(confirmedMinor) + BigInt(pendingMinor) !== BigInt(amountMinor) ||
            (entry.state === "Confirmed"
              ? confirmedMinor !== amountMinor || pendingMinor !== "0"
              : confirmedMinor !== "0" || pendingMinor !== amountMinor)
          )
            return fail();
          const executionOperationReference =
            entry.state === "NotDispatched"
              ? entry.executionOperationReference === null
                ? null
                : fail()
              : ref(entry.executionOperationReference);
          return Object.freeze({
            executionOperationReference,
            paymentAttemptReference: ref(entry.paymentAttemptReference),
            paymentIntentReference: ref(entry.paymentIntentReference),
            state: entry.state,
            amountMinor,
            confirmedMinor,
            pendingMinor,
          });
        });
        if (
          new Set(payments.map((p) => p.paymentAttemptReference)).size !== payments.length ||
          new Set(payments.map((p) => p.paymentIntentReference)).size !== payments.length ||
          payments.reduce((sum, p) => sum + BigInt(p.amountMinor), 0n) !==
            BigInt(money(data.amountMinor))
        )
          return fail();
        return Object.freeze({
          orderReference,
          operationReference,
          requestReference: ref(data.requestReference),
          observedAt: data.observedAt,
          currencyCode: "CAD" as const,
          amountMinor: money(data.amountMinor),
          payments: Object.freeze(payments),
        });
      }, false);
    },
    async items(orderReference: string, csrf: string, signal?: AbortSignal) {
      ref(orderReference);
      return boundary(async () => {
        const data = exact(
          await send(
            "/merchant/payments/refunds/items",
            JSON.stringify({ orderReference }),
            csrf,
            200,
            signal,
          ),
          ["orderReference", "orderNumber", "claimVersion", "items", "recentRequests"],
        );
        if (
          data.orderReference !== orderReference ||
          !Array.isArray(data.items) ||
          data.items.length > 1000
        )
          return fail();
        const items = data.items.map((value) => {
          const item = exact(value, [
              "orderBatchReference",
              "orderItemReference",
              "label",
              "quantity",
              "unclaimedQuantity",
              "paymentCaptured",
              "paymentIntentReference",
            ]),
            quantity = count(item.quantity, 1, 999),
            unclaimedQuantity = count(item.unclaimedQuantity, 0, quantity);
          if (
            typeof item.paymentCaptured !== "boolean" ||
            (!item.paymentCaptured && unclaimedQuantity !== 0)
          )
            return fail();
          return Object.freeze({
            orderBatchReference: ref(item.orderBatchReference),
            orderItemReference: ref(item.orderItemReference),
            label: label(item.label),
            quantity,
            unclaimedQuantity,
            paymentCaptured: item.paymentCaptured,
            paymentIntentReference: item.paymentCaptured
              ? ref(item.paymentIntentReference)
              : item.paymentIntentReference === null
                ? null
                : fail(),
          });
        });
        if (new Set(items.map((item) => item.orderItemReference)).size !== items.length)
          return fail();
        const claimVersion = count(data.claimVersion, 0, 1000);
        if (
          !Array.isArray(data.recentRequests) ||
          data.recentRequests.length !== Math.min(20, claimVersion)
        )
          return fail();
        const recentRequests = data.recentRequests.map((value, index) => {
          const entry = exact(value, [
            "requestReference",
            "operationReference",
            "claimVersion",
            "requestedAt",
            "reasonCode",
            "currencyCode",
            "amountMinor",
          ]);
          if (
            entry.claimVersion !== claimVersion - Math.min(20, claimVersion) + index + 1 ||
            typeof entry.requestedAt !== "string" ||
            !Number.isFinite(Date.parse(entry.requestedAt)) ||
            new Date(entry.requestedAt).toISOString() !== entry.requestedAt ||
            typeof entry.reasonCode !== "string" ||
            !/^[A-Z][A-Z0-9_]{0,63}$/u.test(entry.reasonCode) ||
            entry.currencyCode !== "CAD" ||
            money(entry.amountMinor) === "0"
          )
            return fail();
          return Object.freeze({
            requestReference: ref(entry.requestReference),
            operationReference: ref(entry.operationReference),
            claimVersion: count(entry.claimVersion, 1, 1000),
            requestedAt: entry.requestedAt,
            reasonCode: entry.reasonCode,
            currencyCode: "CAD" as const,
            amountMinor: money(entry.amountMinor),
          });
        });
        if (
          new Set(recentRequests.map((entry) => entry.requestReference)).size !==
            recentRequests.length ||
          new Set(recentRequests.map((entry) => entry.operationReference)).size !==
            recentRequests.length
        )
          return fail();
        return Object.freeze({
          recentRequests: Object.freeze(recentRequests),
          orderReference,
          orderNumber: label(data.orderNumber),
          claimVersion: count(data.claimVersion, 0, 1000),
          items: Object.freeze(items),
        });
      }, false);
    },
    prepareRequest(value: RefundRequestCommand) {
      const snapshot = command(value),
        body = JSON.stringify(snapshot);
      let submitted = false;
      let confirmed: Readonly<{
        amountMinor: string;
        paymentAttemptReferences: readonly string[];
        components: Readonly<Record<string, string>>;
      }> | null = null;
      return Object.freeze({
        async preview(csrf: string, signal?: AbortSignal) {
          if (submitted) return fail();
          confirmed = null;
          return boundary(async () => {
            const data = exact(
              await send("/merchant/payments/refunds/preview", body, csrf, 200, signal),
              [
                "status",
                "requestReference",
                "operationReference",
                "claimVersion",
                "currencyCode",
                "amountMinor",
                "paymentAttemptReferences",
                "components",
              ],
            );
            if (
              data.status !== "Previewed" ||
              data.requestReference !== snapshot.requestReference ||
              data.operationReference !== snapshot.operationReference ||
              data.claimVersion !== snapshot.expectedClaimVersion ||
              data.currencyCode !== "CAD"
            )
              return fail();
            const amountMinor = money(data.amountMinor),
              raw = exact(data.components, components);
            const allocation = Object.freeze(
              Object.fromEntries(components.map((key) => [key, money(raw[key])])),
            );
            if (
              BigInt(amountMinor) <= 0n ||
              Object.values(allocation).reduce((sum, part) => sum + BigInt(part), 0n) !==
                BigInt(amountMinor)
            )
              return fail();
            confirmed = Object.freeze({
              amountMinor,
              components: allocation,
              paymentAttemptReferences: attempts(data.paymentAttemptReferences),
            });
            return Object.freeze({
              status: "Previewed" as const,
              currencyCode: "CAD" as const,
              ...confirmed,
            });
          }, false);
        },
        async submit(csrf: string, signal?: AbortSignal) {
          if (!confirmed) return fail();
          const preview = confirmed;
          submitted = true;
          return boundary(async () => {
            const data = exact(
              await send("/merchant/payments/refunds/request", body, csrf, 202, signal),
              [
                "status",
                "requestReference",
                "operationReference",
                "claimVersion",
                "currencyCode",
                "amountMinor",
                "paymentAttemptReferences",
                "replayed",
              ],
            );
            if (
              data.status !== "RequestRecorded" ||
              data.requestReference !== snapshot.requestReference ||
              data.operationReference !== snapshot.operationReference ||
              data.claimVersion !== snapshot.expectedClaimVersion + 1 ||
              data.currencyCode !== "CAD" ||
              data.amountMinor !== preview.amountMinor ||
              typeof data.replayed !== "boolean" ||
              JSON.stringify([...attempts(data.paymentAttemptReferences)].sort()) !==
                JSON.stringify([...preview.paymentAttemptReferences].sort())
            )
              return fail();
            return Object.freeze({
              status: "RequestRecorded" as const,
              requestReference: snapshot.requestReference,
              operationReference: snapshot.operationReference,
              claimVersion: snapshot.expectedClaimVersion + 1,
              currencyCode: "CAD" as const,
              amountMinor: preview.amountMinor,
              paymentAttemptReferences: preview.paymentAttemptReferences,
              replayed: data.replayed,
            });
          }, true);
        },
      });
    },
  });
}
