import { t } from "./i18n/i18n.js";
import { useSyncExternalStore } from "react";
import { createOwnNameClient, type OwnNameClient, type OwnNameState } from "./OwnNamePrompt.js";
import { usePinStatusSnapshot } from "./StaffPinControls.js";
import { StaffSessionGuard } from "./StaffSession.js";
import type { StaffPinClient } from "./staff-pin-client.js";

/**
 * WP-2423 M61: the workspace frame says who is signed in on this screen, so on a shared tablet
 * the person about to accept an order or take a payment sees whose name the record will show.
 * The name is the member's name at the selected Store (a per-Store fact), so the read is keyed by
 * the sign-in and the Store: switching Store reads it again. A failed read shows nothing (never a
 * guess); no recorded name says so (Home asks for it).
 */
type NameSnapshot =
  | { readonly kind: "Loading" }
  | { readonly kind: "Ready"; readonly state: OwnNameState }
  | { readonly kind: "Failed" };

export class NameStore {
  private snapshot: NameSnapshot = { kind: "Loading" };
  private readonly listeners = new Set<() => void>();
  private started = false;
  constructor(private readonly client: OwnNameClient) {}
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (!this.started) {
      this.started = true;
      void this.client.read().then(
        (state) => this.set({ kind: "Ready", state }),
        () => this.set({ kind: "Failed" }),
      );
    }
    return () => this.listeners.delete(listener);
  };
  readonly get = () => this.snapshot;
  private set(next: NameSnapshot) {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

// One read per sign-in and Store, shared by the sidebar and the compact menu.
const names = new Map<string, NameStore>();
export function staffNameStoreFor(
  csrf: string,
  storeReference: string,
  client?: OwnNameClient,
): NameStore {
  const key = csrf + "|" + storeReference;
  let store = names.get(key);
  if (store === undefined) {
    store = new NameStore(client ?? createOwnNameClient(csrf));
    names.clear();
    names.set(key, store);
  }
  return store;
}

export function staffIdentityText(
  state: OwnNameState,
  signIn: "Pin" | "Account" | null,
): string | null {
  if (state.name === "NotStoreMember") return null;
  const name = state.name === "Recorded" ? state.displayName : t("Name not added yet");
  if (signIn === "Pin") return t("{name} · signed in with PIN", { name });
  return t("{name} · signed in", { name });
}

export function StaffIdentityLine({
  csrf,
  storeReference,
  nameClient,
  pinClient,
}: {
  readonly csrf: string;
  readonly storeReference: string;
  readonly nameClient?: OwnNameClient;
  readonly pinClient?: StaffPinClient;
}) {
  const store = staffNameStoreFor(csrf, storeReference, nameClient);
  const snapshot = useSyncExternalStore(store.subscribe, store.get, store.get);
  const pin = usePinStatusSnapshot(csrf, pinClient);
  if (snapshot.kind !== "Ready") return null;
  const text = staffIdentityText(snapshot.state, pin.kind === "Ready" ? pin.status.signIn : null);
  if (text === null) return null;
  return (
    <p className="staff-identity" aria-label={t("Signed in on this screen")}>
      {text}
    </p>
  );
}

/**
 * WP-2423 M61: the session guard with this sign-in's shared-tablet idle return (from the PIN
 * status the footer already reads: PIN sign-ins only).
 */
export function TabletStaffSessionGuard(
  props: Omit<Parameters<typeof StaffSessionGuard>[0], "idleReturnMinutes">,
) {
  const pin = usePinStatusSnapshot(props.csrf);
  const minutes = pin.kind === "Ready" ? (pin.status.tabletIdleReturnMinutes ?? null) : null;
  return <StaffSessionGuard {...props} idleReturnMinutes={minutes} />;
}
