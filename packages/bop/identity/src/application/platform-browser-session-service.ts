import {
  StrongBrowserSessionService,
  type StrongBrowserSessionServiceOptions,
} from "./strong-browser-session-service.js";
import type {
  PlatformBrowserSessionStorePort,
  PlatformOidcProviderPort,
} from "../contracts/platform-browser-session.js";

export interface PlatformBrowserSessionServiceOptions extends Omit<
  StrongBrowserSessionServiceOptions,
  "store" | "provider"
> {
  readonly store: PlatformBrowserSessionStorePort;
  readonly provider: PlatformOidcProviderPort;
}
/** Fixed Platform authentication entry. Session proof grants no business permission. */
export class PlatformBrowserSessionService extends StrongBrowserSessionService<"Platform"> {
  constructor(options: PlatformBrowserSessionServiceOptions) {
    super(options, "Platform");
  }
}
