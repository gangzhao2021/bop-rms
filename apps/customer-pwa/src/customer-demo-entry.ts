import type { CustomerDemoDependencies } from "./customer-demo.js";

export function shouldUseLocalCustomerDemoEntry(
  command: "build" | "serve",
  flag: string | undefined,
): boolean {
  return command === "serve" && flag === "1";
}

export async function loadLocalCustomerDemo(
  load: () => Promise<{ readonly enabledCustomerDemo: CustomerDemoDependencies }>,
): Promise<CustomerDemoDependencies | null> {
  try {
    return (await load()).enabledCustomerDemo;
  } catch {
    return null;
  }
}
