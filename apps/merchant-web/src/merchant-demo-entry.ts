import type { MerchantDemoClients } from "./merchant-demo.js";

export function shouldUseLocalMerchantDemoEntry(
  command: "build" | "serve",
  flag: string | undefined,
): boolean {
  return command === "serve" && flag === "1";
}

export async function loadLocalMerchantDemo(
  load: () => Promise<{ readonly enabledMerchantDemoClients: MerchantDemoClients }>,
): Promise<MerchantDemoClients | null> {
  try {
    return (await load()).enabledMerchantDemoClients;
  } catch {
    return null;
  }
}
