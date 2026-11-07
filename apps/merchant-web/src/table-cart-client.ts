/**
 * WP-2423 shared-table-checkout (c): what guests put in a table's shared cart and haven't sent
 * (dish, how many, which phone, whether it left), and staff take a dish out with a reason.
 */
export type TableCartErrorCode =
  | "PermissionDenied"
  | "Unavailable"
  | "OutcomeUnknown"
  /** The cart changed since staff looked (a guest added, removed or sent): read it again. */
  | "Changed"
  /** A guest is paying for exactly these dishes now. */
  | "GuestPaying";
export class TableCartError extends Error {
  constructor(readonly code: TableCartErrorCode) {
    super("table cart " + code);
    this.name = "TableCartError";
  }
}
export type TableCartRemovalReason = "GuestAsked" | "GuestLeft" | "CantMake";
export interface TableCartLine {
  readonly cartItemReference: string;
  readonly names: Readonly<Record<string, string>>;
  readonly quantity: number;
  readonly withOptions: boolean;
  /** "Phone N" that added it; null when staff entered it. */
  readonly phoneNumber: number | null;
  readonly phoneLeft: boolean;
}
export interface TableCart {
  readonly cartReference: string;
  readonly cartVersion: number;
  readonly guestPaying: boolean;
  readonly lines: readonly TableCartLine[];
}

const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const fail = (): never => {
  throw new TableCartError("Unavailable");
};
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail();
  const own = Object.keys(value);
  if (own.length !== keys.length || own.some((key) => !keys.includes(key))) return fail();
  return value as Record<string, unknown>;
}
const ref = (value: unknown) =>
  typeof value === "string" && reference.test(value) ? value : fail();
const count = (value: unknown, max: number) =>
  Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= max
    ? Number(value)
    : fail();

export function parseTableCart(value: unknown): TableCart | null {
  const raw = exact(value, ["cart"]);
  if (raw.cart === null) return null;
  const cart = exact(raw.cart, ["cartReference", "cartVersion", "guestPaying", "lines"]);
  if (
    typeof cart.guestPaying !== "boolean" ||
    !Array.isArray(cart.lines) ||
    cart.lines.length > 100
  )
    return fail();
  const lines = cart.lines.map((entry: unknown) => {
    const line = exact(entry, [
      "cartItemReference",
      "names",
      "quantity",
      "withOptions",
      "phoneNumber",
      "phoneLeft",
    ]);
    const names = exact(line.names, Object.keys((line.names as object | null) ?? {}));
    if (
      typeof line.withOptions !== "boolean" ||
      typeof line.phoneLeft !== "boolean" ||
      Object.values(names).some((name) => typeof name !== "string")
    )
      return fail();
    return Object.freeze({
      cartItemReference: ref(line.cartItemReference),
      names: Object.freeze({ ...(names as Record<string, string>) }),
      quantity: count(line.quantity, 999),
      withOptions: line.withOptions,
      phoneNumber: line.phoneNumber === null ? null : count(line.phoneNumber, 200),
      phoneLeft: line.phoneLeft,
    });
  });
  return Object.freeze({
    cartReference: ref(cart.cartReference),
    cartVersion: count(cart.cartVersion, Number.MAX_SAFE_INTEGER),
    guestPaying: cart.guestPaying,
    lines: Object.freeze(lines),
  });
}

export function createTableCartClient(fetcher: typeof fetch = fetch) {
  const post = async (csrf: string, body: unknown, signal?: AbortSignal) => {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(csrf)) throw new TableCartError("Unavailable");
    let response: Response;
    try {
      response = await fetcher("/merchant/dining/sessions/table-cart", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: signal ?? null,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-BOP-CSRF": csrf,
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new TableCartError("OutcomeUnknown");
    }
    if (response.status === 401 || response.status === 403)
      throw new TableCartError("PermissionDenied");
    if (response.status === 409) {
      const error = (await response.json().catch(() => null)) as { error?: unknown } | null;
      throw new TableCartError(
        error?.error === "dining_table_cart_guest_paying" ? "GuestPaying" : "Changed",
      );
    }
    if (!response.ok || response.headers.get("cache-control") !== "no-store")
      throw new TableCartError(response.status >= 500 ? "OutcomeUnknown" : "Unavailable");
    return parseTableCart(await response.json().catch(() => null));
  };
  return Object.freeze({
    read: (csrf: string, diningSessionReference: string, signal?: AbortSignal) =>
      post(csrf, { action: "Read", diningSessionReference }, signal),
    remove: (
      csrf: string,
      command: {
        readonly diningSessionReference: string;
        readonly cartReference: string;
        readonly cartItemReference: string;
        readonly expectedCartVersion: number;
        readonly reason: TableCartRemovalReason;
        readonly operationReference: string;
      },
    ) => post(csrf, { action: "Remove", ...command }),
  });
}
