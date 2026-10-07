import {
  StrongBrowserSessionService,
  type StrongBrowserSessionServiceOptions,
} from "./strong-browser-session-service.js";
import type {
  WorkforceBrowserSessionStorePort,
  WorkforceOidcProviderPort,
} from "../contracts/workforce-browser-session.js";

export interface WorkforceBrowserSessionServiceOptions extends Omit<
  StrongBrowserSessionServiceOptions,
  "store" | "provider"
> {
  readonly store: WorkforceBrowserSessionStorePort;
  readonly provider: WorkforceOidcProviderPort;
}
/** Fixed Workforce authentication entry. Session proof grants no business permission. */
export class WorkforceBrowserSessionService extends StrongBrowserSessionService<"Workforce"> {
  constructor(options: WorkforceBrowserSessionServiceOptions) {
    super(options, "Workforce");
  }
  /** Fixed POST invitation entry; the ordinary login and step-up keep their
   * existing account-binding resolver and cannot fall back to enrollment. */
  startInvitation(input: unknown) {
    return this.startInvited(input);
  }
}
