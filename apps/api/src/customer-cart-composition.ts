import { GuestSessionError, type GuestSession, type GuestSessionService } from "@bop/identity";
import {
  CartError,
  createCustomerCartService,
  createEmptyCustomerCartView,
  parseCustomerCartDisplay,
  type CustomerCartDisplayRequest,
  type CustomerCartPorts,
} from "@rms/ordering";
import type { CustomerCartPort, CustomerCartPortResult } from "./customer-cart.js";

export interface CustomerCartCompositionOptions {
  readonly session: Pick<GuestSessionService, "authorize" | "resolve">;
  readonly ordering: (session: GuestSession) => Omit<CustomerCartPorts, "authorization">;
  readonly display: { resolve(request: CustomerCartDisplayRequest): Promise<unknown> };
}
const unavailable = Object.freeze({ status: "Unavailable" } as const);
function failure(error: unknown): CustomerCartPortResult {
  if (error instanceof GuestSessionError) return { status: "SessionExpired" };
  if (error instanceof CartError) {
    if (error.code === "CART_PERMISSION_DENIED") return { status: "SessionExpired" };
    if (error.code === "CART_IDEMPOTENCY_CONFLICT") return { status: "IdempotencyConflict" };
    if (error.code === "CART_EXPIRED") return { status: "LifecycleExpired" };
    if (error.code === "CART_ABANDONED") return { status: "LifecycleAbandoned" };
  }
  return unavailable;
}
export function createCustomerCartComposition(
  options: CustomerCartCompositionOptions,
): CustomerCartPort {
  async function execute(
    input: {
      guestCredential: string;
      requestedAt: string;
      csrfCredential?: string;
      operationReference?: string;
      cartReference?: string;
    },
    create: boolean,
  ): Promise<CustomerCartPortResult> {
    try {
      const session = create
        ? await options.session.authorize({
            sessionCredential: input.guestCredential,
            csrfCredential: input.csrfCredential,
            observedAt: input.requestedAt,
          })
        : await options.session.resolve({
            sessionCredential: input.guestCredential,
            activity: "Background",
            observedAt: input.requestedAt,
          });
      const service = createCustomerCartService({
        ...options.ordering(session),
        authorization: {
          async authorize() {
            return session;
          },
        },
      });
      const request: CustomerCartDisplayRequest = Object.freeze({
        purpose: "CustomerCart",
        brandReference: session.brandReference,
        storeReference: session.storeReference,
        publicStoreReference: session.publicStoreReference,
        locale: session.locale,
        orderType: session.channel,
        evaluatedAt: input.requestedAt,
      });
      // Resolve and validate required public content before a write. No fake labels or price source.
      const display = parseCustomerCartDisplay(await options.display.resolve(request), request);
      const result = create
        ? await service.create({
            operationReference: input.operationReference,
            requestedAt: input.requestedAt,
          })
        : await service.current({ requestedAt: input.requestedAt });
      if (
        result.status === "NotFound" ||
        (input.cartReference !== undefined &&
          input.cartReference !== result.aggregate.cartReference)
      )
        return { status: "NotFound" };
      return {
        status: create ? (result.status === "Created" ? "Applied" : "Current") : "Found",
        view: createEmptyCustomerCartView(result.aggregate, display),
      };
    } catch (error) {
      return failure(error);
    }
  }
  return Object.freeze<CustomerCartPort>({
    createCart: (input) => execute(input, true),
    getCurrentCart: (input) => execute(input, false),
    getCart: (input) => execute(input, false),
    async addItem() {
      return unavailable;
    },
    async updateItem() {
      return unavailable;
    },
    async removeItem() {
      return unavailable;
    },
  });
}
