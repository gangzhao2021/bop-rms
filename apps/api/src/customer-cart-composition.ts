import { GuestSessionError, type GuestSession, type GuestSessionService } from "@bop/identity";
import {
  CartError,
  createCartItemCommandService,
  createCartItemResultView,
  type CartItemCommandPorts,
  createCustomerCartService,
  createCustomerCartPresentationService,
  type CustomerCartPresentationPorts,
  createEmptyCustomerCartView,
  parseCustomerCartDisplay,
  type CustomerCartDisplayRequest,
  type CustomerCartPorts,
} from "@rms/ordering";
import type { CustomerCartPort, CustomerCartPortResult } from "./customer-cart.js";

export interface CustomerCartCompositionOptions {
  readonly session: Pick<GuestSessionService, "authorize" | "resolve">;
  readonly ordering: (session: GuestSession) => Omit<CustomerCartPorts, "authorization">;
  readonly items?: (session: GuestSession) => Omit<CartItemCommandPorts, "presentation">;
  readonly presentation?: (session: GuestSession) => CustomerCartPresentationPorts;
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
        view:
          !create && options.presentation !== undefined
            ? await createCustomerCartPresentationService(options.presentation(session)).getView(
                result.aggregate,
                display,
              )
            : createEmptyCustomerCartView(result.aggregate, display),
      };
    } catch (error) {
      return failure(error);
    }
  }
  async function mutate(
    method: "add" | "update" | "remove",
    input:
      | Parameters<CustomerCartPort["addItem"]>[0]
      | Parameters<CustomerCartPort["updateItem"]>[0]
      | Parameters<CustomerCartPort["removeItem"]>[0],
  ): Promise<CustomerCartPortResult> {
    if (options.items === undefined || options.presentation === undefined) return unavailable;
    let dependencies: ReturnType<NonNullable<CustomerCartCompositionOptions["items"]>> | undefined;
    try {
      const authorize = () =>
        options.session.authorize({
          sessionCredential: input.guestCredential,
          csrfCredential: input.csrfCredential,
          observedAt: input.requestedAt,
        });
      const session = await authorize();
      if (session.channel !== "Pickup") return unavailable;
      dependencies = options.items(session);
      if (dependencies.repository.unquotedPresentation !== true) return unavailable;
      const current = await dependencies.repository.load(input.cartReference as never);
      if (
        current === null ||
        current.brandReference !== String(session.brandReference) ||
        current.storeReference !== String(session.storeReference) ||
        current.orderType !== "Pickup" ||
        current.createdByActorReference !== String(session.sessionReference)
      )
        return { status: "NotFound" };
      const deps = dependencies;
      const commandService = createCartItemCommandService({
        ...deps,
        authorization: {
          async authorize(request) {
            let fresh;
            try {
              fresh = await authorize();
            } catch {
              return null;
            }
            const evidence = await deps.authorization.authorize(request);
            return evidence === null ? null : { guestSession: fresh, audit: evidence.audit };
          },
        },
        presentation: {
          async prepare(aggregate) {
            const request: CustomerCartDisplayRequest = {
              purpose: "CustomerCart",
              brandReference: session.brandReference,
              storeReference: session.storeReference,
              publicStoreReference: session.publicStoreReference,
              locale: session.locale,
              orderType: session.channel,
              evaluatedAt: input.requestedAt,
            };
            const display = parseCustomerCartDisplay(
              await options.display.resolve(request),
              request,
            );
            const source = options.presentation;
            if (source === undefined) throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
            return createCustomerCartPresentationService(source(session)).prepareSnapshot(
              aggregate,
              display,
            );
          },
        },
      });
      const command = {
        cartReference: input.cartReference,
        operationReference: input.operationReference,
        requestedAt: input.requestedAt,
        expectedAggregateVersion: input.expectedCartVersion,
        ...("cartItemReference" in input ? { cartItemReference: input.cartItemReference } : {}),
        ...("sellableReference" in input ? { sellableReference: input.sellableReference } : {}),
        ...("quantity" in input
          ? {
              quantity: input.quantity,
              optionSelections: input.optionSelections,
              customerNote: input.customerNote,
            }
          : {}),
      };
      const result = await commandService[method](command);
      return {
        status: result.status === "Applied" ? "Applied" : "Current",
        view: createCartItemResultView(result),
      };
    } catch (error) {
      if (error instanceof CartError) {
        if (error.code === "CART_ITEM_NOT_FOUND" || error.code === "CART_UNAVAILABLE")
          return { status: "NotFound" };
        if (error.code === "CART_SELECTION_INVALID" || error.code === "CART_ITEM_LIMIT_REACHED")
          return { status: "SelectionInvalid", issueCodes: ["SELECTION_INVALID"] };
        if (error.code === "CART_VERSION_CONFLICT" && dependencies !== undefined) {
          try {
            const session = await options.session.authorize({
              sessionCredential: input.guestCredential,
              csrfCredential: input.csrfCredential,
              observedAt: input.requestedAt,
            });
            const current = await dependencies.repository.load(input.cartReference as never);
            if (
              current !== null &&
              current.brandReference === String(session.brandReference) &&
              current.storeReference === String(session.storeReference) &&
              current.createdByActorReference === String(session.sessionReference)
            )
              return { status: "VersionConflict", currentVersion: current.aggregateVersion };
          } catch {
            return unavailable;
          }
        }
      }
      return failure(error);
    }
  }
  return Object.freeze<CustomerCartPort>({
    createCart: (input) => execute(input, true),
    getCurrentCart: (input) => execute(input, false),
    getCart: (input) => execute(input, false),
    addItem: (input) => mutate("add", input),
    updateItem: (input) => mutate("update", input),
    removeItem: (input) => mutate("remove", input),
  });
}
