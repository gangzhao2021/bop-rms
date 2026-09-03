import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { loadEnv } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { shouldUseLocalCustomerDemoEntry } from "./src/customer-demo-entry.js";

export default defineConfig(({ command, mode }) => {
  const candidate = loadEnv(mode, ".", "BOP_").BOP_DEPLOYMENT_ID ?? "local-dev";
  const useLocalDemo = shouldUseLocalCustomerDemoEntry(
    command,
    process.env.VITE_BOP_LOCAL_CUSTOMER_DEMO,
  );
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(candidate))
    throw new Error("BOP_DEPLOYMENT_ID must be a safe deployment label");
  return {
    define: { __BOP_DEPLOYMENT_ID__: JSON.stringify(candidate) },
    plugins: [
      {
        name: "bop-local-customer-demo-entry",
        transformIndexHtml(html) {
          return useLocalDemo ? html.replace("/src/main.tsx", "/src/main.demo.tsx") : html;
        },
      },
      react(),
      tailwindcss(),
      VitePWA({
        strategies: "injectManifest",
        srcDir: "src",
        filename: "service-worker.ts",
        injectRegister: null,
        registerType: "prompt",
        manifest: false,
        injectManifest: {
          globPatterns: ["**/*.{js,css,woff2,html,webmanifest}"],
          globIgnores: ["**/*.map"],
        },
        devOptions: { enabled: false },
      }),
    ],
    build: { target: "es2024" },
  };
});
