import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { loadEnv } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ mode }) => {
  const candidate = loadEnv(mode, ".", "BOP_").BOP_DEPLOYMENT_ID ?? "local-dev";
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(candidate))
    throw new Error("BOP_DEPLOYMENT_ID must be a safe deployment label");
  return {
    define: { __BOP_DEPLOYMENT_ID__: JSON.stringify(candidate) },
    plugins: [
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
