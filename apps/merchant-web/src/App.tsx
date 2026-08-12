import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, Route, Routes } from "react-router";
import { MerchantShell } from "./MerchantShell.js";
import { StoreDetailPage, StoreListPage, StoreSetupPage } from "./StoreAdminPages.js";
import {
  createMerchantWorkspaceClient,
  type MerchantWorkspaceClient,
  type MerchantWorkspaceSnapshot,
} from "./merchant-workspace.js";

type WorkspaceState =
  | { readonly kind: "Loading" }
  | { readonly kind: "SignedOut" }
  | { readonly kind: "Offline" }
  | { readonly kind: "Failure" }
  | {
      readonly kind: "Ready";
      readonly csrf: string;
      readonly switching: boolean;
      readonly switchFailed: boolean;
      readonly workspace: MerchantWorkspaceSnapshot;
    };

export interface AppProps {
  readonly client?: MerchantWorkspaceClient;
}

export function App({ client: injectedClient }: AppProps = {}) {
  const client = useMemo(() => injectedClient ?? createMerchantWorkspaceClient(), [injectedClient]);
  const [state, setState] = useState<WorkspaceState>({ kind: "Loading" });
  const switching = useRef(false);

  useEffect(() => {
    let active = true;
    void client
      .bootstrap()
      .then((result) => {
        if (!active) return;
        setState(
          result === null
            ? { kind: "SignedOut" }
            : {
                kind: "Ready",
                csrf: result.csrf,
                switching: false,
                switchFailed: false,
                workspace: result.workspace,
              },
        );
      })
      .catch(() => {
        if (active) setState({ kind: navigator.onLine ? "Failure" : "Offline" });
      });
    return () => {
      active = false;
    };
  }, [client]);

  const switchStore = async (targetStoreReference: string) => {
    if (state.kind !== "Ready" || state.switching || switching.current) return;
    switching.current = true;
    const current = state;
    setState({ ...current, switching: true, switchFailed: false });
    try {
      const refreshed = await client.switchStore(current.csrf, targetStoreReference);
      setState({
        ...current,
        csrf: refreshed.csrf,
        switching: false,
        switchFailed: false,
        workspace: refreshed.workspace,
      });
    } catch {
      setState({ ...current, switching: false, switchFailed: true });
    } finally {
      switching.current = false;
    }
  };

  return (
    <Routes>
      <Route path="/app" element={<MerchantShell state={state} onSwitchStore={switchStore} />} />
      <Route path="/app/organization/stores" element={<StoreListPage />} />
      <Route path="/app/organization/stores/:id/setup" element={<StoreSetupPage />} />
      <Route path="/app/organization/stores/:id" element={<StoreDetailPage />} />
      <Route path="*" element={<Navigate replace to="/app" />} />
    </Routes>
  );
}
