declare module "vite-plugin-pwa" {
  import type { Plugin } from "vite";

  export function VitePWA(options: Readonly<Record<string, unknown>>): Plugin;
}

declare module "virtual:pwa-register" {
  export interface RegisterSWOptions {
    readonly immediate?: boolean;
    readonly onNeedRefresh?: () => void;
  }

  export function registerSW(options?: RegisterSWOptions): (reloadPage?: boolean) => Promise<void>;
}
