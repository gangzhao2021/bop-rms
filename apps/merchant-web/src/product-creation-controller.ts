import {
  ProductCommandClientError,
  type CreateProductCommand,
  type ProductCreationReceipt,
  createProductCommandClient,
} from "./catalog-product-command-client.js";
import {
  StoreCapabilityClientError,
  type createStoreCapabilityClient,
} from "./store-capability-client.js";
import {
  parseProductCategoryLookupView,
  type ProductCategoryLookupView,
} from "./catalog-product-category-lookup-client.js";
import {
  selectProductCategoryClassification,
  ProductCategorySelectionError,
} from "./catalog-product-category-selection.js";
import { copyProductCommandValue } from "./catalog-product-command-values.js";

export type CreationState =
  | "Unavailable"
  | "Ready"
  | "Stale"
  | "Denied"
  | "Disabled"
  | "ScopeChanged"
  | "Invalid"
  | "Conflict"
  | "OutcomeUnknown"
  | "Confirmed";
export class ProductCreationError extends Error {
  constructor(readonly code: CreationState) {
    super("Product creation could not be confirmed");
  }
}
/** One original in this live context. This is neither permission nor durable discovery. */
export function createProductCreationController(options: {
  readonly storeReference: string;
  readonly currentContext: () => number;
  readonly now: () => number;
  readonly capabilities: ReturnType<typeof createStoreCapabilityClient>;
  readonly commands: ReturnType<typeof createProductCommandClient>;
}) {
  const context = options.currentContext();
  let state: CreationState = "Unavailable",
    validUntil: number | null = null,
    brandReference: string | null = null,
    busy = false,
    clockFloor = -Infinity,
    pending: ReturnType<ReturnType<typeof createProductCommandClient>["prepareCreate"]> | null =
      null,
    receipt: ProductCreationReceipt | null = null;
  const current = (signal?: AbortSignal) => {
    if (options.currentContext() !== context || signal?.aborted)
      throw new ProductCreationError("ScopeChanged");
  };
  const clock = () => {
    const at = options.now();
    if (!Number.isFinite(at) || at < clockFloor) throw new ProductCreationError("Stale");
    clockFloor = at;
    return at;
  };
  async function gate(csrf: string, signal?: AbortSignal) {
    current(signal);
    clock();
    const value = await options.capabilities.load(
      {
        scope: {
          storeReference: options.storeReference,
          ...(brandReference ? { brandReference } : {}),
        },
        capabilityKey: "catalog.cat_product_create",
        csrf,
      },
      signal ?? new AbortController().signal,
    );
    current(signal);
    if (
      value.capabilityKey !== "catalog.cat_product_create" ||
      value.controlKey !== "catalog.product.create"
    )
      throw new ProductCreationError("Unavailable");
    if (
      value.storeReference !== options.storeReference ||
      (brandReference !== null && value.brandReference !== brandReference)
    )
      throw new ProductCreationError("ScopeChanged");
    const at = clock(),
      observed = Date.parse(value.observedAt);
    if (
      !Number.isFinite(at) ||
      !Number.isFinite(observed) ||
      at < observed ||
      at >= observed + 5000
    )
      throw new ProductCreationError("Stale");
    if (value.backendExecution !== "Allow" || value.frontendVisibility !== "Show")
      throw new ProductCreationError(value.reason === "Disabled" ? "Disabled" : "Unavailable");
    brandReference = value.brandReference;
    validUntil = observed + 5000;
    return { brandReference, storeReference: options.storeReference };
  }
  async function run(action: () => Promise<void>) {
    if (busy) throw new ProductCreationError("Unavailable");
    busy = true;
    try {
      await action();
    } catch (error) {
      const code =
        error instanceof ProductCreationError
          ? error.code
          : error instanceof ProductCategorySelectionError
            ? error.code
            : error instanceof StoreCapabilityClientError
              ? error.code
              : error instanceof ProductCommandClientError
                ? error.code === "FeatureDisabled"
                  ? "Disabled"
                  : error.code
                : "Unavailable";
      state = pending ? "OutcomeUnknown" : code;
      throw new ProductCreationError(state);
    } finally {
      busy = false;
    }
  }
  async function execute(csrf: string, signal?: AbortSignal) {
    if (!pending) throw new ProductCreationError("Unavailable");
    try {
      const result = await pending.execute(csrf, signal);
      current(signal);
      receipt = result;
      pending = null;
      state = "Confirmed";
    } catch (error) {
      // Only an original definitive response can release a new-intent barrier.
      // The transport keeps subsequent refusals uncertain after any lost reply.
      if (error instanceof ProductCommandClientError && error.code !== "OutcomeUnknown")
        pending = null;
      throw error;
    }
  }
  return Object.freeze({
    view() {
      const at = options.now();
      const actual =
        state === "Ready" &&
        (!Number.isFinite(at) || at < clockFloor || (validUntil !== null && at >= validUntil))
          ? "Stale"
          : state;
      if (Number.isFinite(at) && at >= clockFloor) clockFloor = at;
      return Object.freeze({
        state: actual,
        validUntil,
        pending: pending !== null,
        receipt,
        busy,
        brandReference,
      });
    },
    refresh(csrf: string, signal?: AbortSignal) {
      return run(async () => {
        if (receipt) return;
        await gate(csrf, signal);
        state = pending ? "OutcomeUnknown" : "Ready";
      });
    },
    create(
      command: CreateProductCommand,
      csrf: string,
      signal?: AbortSignal,
      categorySource?: ProductCategoryLookupView,
    ) {
      return run(async () => {
        if (pending || receipt) throw new ProductCreationError("OutcomeUnknown");
        // Detach the explicit proposal before a source await; getters and later
        // caller edits cannot become a different operation at dispatch time.
        const candidate = copyProductCommandValue(command) as CreateProductCommand;
        // Detach the closed source before awaiting access. This is a UI constraint;
        // native owning assignment policy still holds its own current source.
        const categoryScope = {
          brandReference: brandReference ?? "",
          storeReference: options.storeReference,
          locale: candidate.defaultLocale,
        };
        let selectedSource: ProductCategoryLookupView | null = null;
        if (candidate.categoryClassification !== undefined) {
          if (!categorySource || !brandReference) throw new ProductCreationError("Unavailable");
          selectedSource = parseProductCategoryLookupView(
            categorySource,
            "CAT-PRODUCT-CREATE",
            categoryScope,
          );
        }
        const scope = await gate(csrf, signal);
        if (selectedSource) {
          const at = clock();
          if (at >= Date.parse(selectedSource.lookup.source.asOfUtc) + 5000)
            throw new ProductCreationError("Stale");
          selectProductCategoryClassification(
            candidate.categoryClassification,
            selectedSource,
            "CAT-PRODUCT-CREATE",
            categoryScope,
            at,
          );
        }
        pending = options.commands.prepareCreate(candidate, scope);
        await execute(csrf, signal);
      });
    },
    retry(csrf: string, signal?: AbortSignal) {
      return run(async () => {
        if (!pending) throw new ProductCreationError("Unavailable");
        await gate(csrf, signal);
        await execute(csrf, signal);
      });
    },
  });
}
