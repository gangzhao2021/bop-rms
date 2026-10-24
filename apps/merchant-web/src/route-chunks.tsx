import { t } from "./i18n/i18n.js";
import { StatePanel } from "@bop-rms/ui";
import {
  Component,
  createElement,
  use,
  type ComponentProps,
  type ComponentType,
  type ReactNode,
} from "react";

/**
 * WP-2423 C2: screens outside the first ones staff open (shell, sign-in, Home, Orders, Kitchen)
 * load on first use, so a store tablet on slow Wi-Fi starts faster. A screen whose code does not
 * arrive is fetched once more; if it is still missing while the device is online (a new version
 * was deployed and the old files are gone) the app reloads once to pick up the new files. Offline,
 * or after that one reload, staff see a plain message with "Try again", never a raw error.
 */

const RELOAD_KEY = "bop-merchant-chunk-reload";
/** One automatic reload per minute at most, so a missing file can never cause a reload loop. */
const RELOAD_GUARD_MS = 60_000;
const RETRY_DELAY_MS = 1_000;

/** Thrown when a screen's code could not be loaded; the boundary below shows the retry panel. */
export class PageChunkError extends Error {
  constructor(cause: unknown) {
    super("PAGE_CHUNK_UNAVAILABLE", { cause });
    this.name = "PageChunkError";
  }
}

function reloadOnce(): boolean {
  try {
    const last = Number(globalThis.sessionStorage.getItem(RELOAD_KEY));
    if (last > 0 && Date.now() - last < RELOAD_GUARD_MS) return false;
    globalThis.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  globalThis.location.reload();
  return true;
}

export async function loadChunk<M>(load: () => Promise<M>): Promise<M> {
  try {
    return await load();
  } catch {
    // A dropped request on slow Wi-Fi: wait a moment and ask once more.
  }
  await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  try {
    return await load();
  } catch (error) {
    // Keep showing "Loading this page…" while the reload happens.
    if (globalThis.navigator.onLine && reloadOnce()) return new Promise<M>(() => undefined);
    throw new PageChunkError(error);
  }
}

const failedLoads = new Set<() => void>();
/** Lets every screen whose code failed to load ask for it again on the next render. */
export function retryFailedChunks(): void {
  for (const reset of [...failedLoads]) reset();
}

export interface LazyModule<M> {
  /** Starts (or reuses) the download a screen waits for. */
  readonly preload: () => Promise<M>;
  /** Fetches in the background; a failure is ignored (no message, no reload). */
  readonly prefetch: () => void;
  readonly loaded: () => M | undefined;
}

export function lazyModule<M>(load: () => Promise<M>): LazyModule<M> {
  let value: M | undefined;
  let pending: Promise<M> | undefined;
  const reset = () => {
    pending = undefined;
    failedLoads.delete(reset);
  };
  const preload = () => {
    pending ??= loadChunk(load).then(
      (module) => {
        value = module;
        return module;
      },
      (error: unknown) => {
        failedLoads.add(reset);
        throw error;
      },
    );
    return pending;
  };
  const prefetch = () => {
    if (value !== undefined || pending !== undefined) return;
    load().then(
      (module) => {
        value ??= module;
      },
      () => undefined,
    );
  };
  return { preload, prefetch, loaded: () => value };
}

// The page's own props type is preserved; ComponentType<any> only bounds the export lookup.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPage = ComponentType<any>;
export type LazyPage<P extends AnyPage> = ComponentType<ComponentProps<P>> & {
  readonly prefetch: () => void;
};

export function lazyPage<M extends Record<string, unknown>, K extends keyof M & string>(
  load: () => Promise<M>,
  name: K,
): LazyPage<Extract<M[K], AnyPage>> {
  type Page = Extract<M[K], AnyPage>;
  const module = lazyModule(load);
  function RoutePage(props: ComponentProps<Page>) {
    const page = (module.loaded() ?? use(module.preload()))[name] as Page;
    return createElement(page, props);
  }
  RoutePage.displayName = `Lazy(${name})`;
  return Object.assign(RoutePage, { prefetch: module.prefetch });
}

/** Renders children with a module that loads on first use (the route clients of lazy screens). */
export function WithModule<M>({
  module,
  children,
}: {
  readonly module: LazyModule<M>;
  readonly children: (module: M) => ReactNode;
}) {
  return <>{children(module.loaded() ?? use(module.preload()))}</>;
}

/**
 * Shows "Try again" when a screen's code could not be loaded; any other rendering fault still
 * reaches the application boundary. Opening another screen clears the message. Browsers keep a
 * failed module download for the life of the page, so "Try again" reloads the page once the device
 * is online; while it is still offline the message says so and nothing is reloaded.
 */
export class PageChunkBoundary extends Component<
  { readonly resetKey: string; readonly children: ReactNode },
  { readonly error: unknown; readonly stillOffline: boolean }
> {
  override state: { readonly error: unknown; readonly stillOffline: boolean } = {
    error: null,
    stillOffline: false,
  };
  static getDerivedStateFromError(error: unknown) {
    return { error, stillOffline: false };
  }
  override componentDidUpdate(previous: { readonly resetKey: string }) {
    if (previous.resetKey !== this.props.resetKey && this.state.error !== null) {
      retryFailedChunks();
      this.setState({ error: null, stillOffline: false });
    }
  }
  private readonly retry = () => {
    if (globalThis.navigator.onLine) globalThis.location.reload();
    else this.setState({ stillOffline: true });
  };
  override render() {
    const { error, stillOffline } = this.state;
    if (error === null) return this.props.children;
    if (!(error instanceof PageChunkError)) throw error;
    return (
      <StatePanel heading={t("This page didn't load")} tone="offline">
        <p>
          {t(
            "The connection may have dropped while the page was opening. Check the Wi-Fi, then try again. Nothing you saved is affected.",
          )}
        </p>
        {stillOffline ? (
          <p role="status">
            {t("This device is still offline. Try again once the Wi-Fi is back.")}
          </p>
        ) : null}
        <button type="button" onClick={this.retry}>
          {t("Try again")}
        </button>
      </StatePanel>
    );
  }
}
