import { registerSW } from "virtual:pwa-register";
import { pwaUpdateStore } from "./update-store.js";

export function startCustomerServiceWorker(): void {
  let updateServiceWorker: ((reloadPage?: boolean) => Promise<void>) | null = null;
  updateServiceWorker = registerSW({
    immediate: true,
    onNeedRefresh() {
      pwaUpdateStore.notifyWaiting(async () => {
        if (updateServiceWorker) await updateServiceWorker(true);
      });
    },
  });
}
