import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { shouldUseLocalMerchantDemoEntry } from "./src/merchant-demo-entry.js";

export default defineConfig(({ command }) => {
  const useLocalDemo = shouldUseLocalMerchantDemoEntry(command, process.env.VITE_BOP_LOCAL_DEMO);
  const apiOrigin = command === "serve" ? process.env.BOP_LOCAL_API_ORIGIN : undefined;
  if (apiOrigin !== undefined && !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(apiOrigin))
    throw new Error("Local API origin must be an explicit loopback HTTP endpoint");
  if (apiOrigin !== undefined && Number(new URL(apiOrigin).port) > 65535)
    throw new Error("Local API port is invalid");
  return {
    ...(apiOrigin === undefined
      ? {}
      : {
          server: {
            proxy: {
              "/api": { target: apiOrigin, changeOrigin: false },
              "/bff": { target: apiOrigin, changeOrigin: false },
              "/merchant": { target: apiOrigin, changeOrigin: false },
              "/platform/auth": { target: apiOrigin, changeOrigin: false },
              "/platform/templates": { target: apiOrigin, changeOrigin: false },
            },
          },
        }),
    plugins: [
      {
        name: "bop-local-merchant-demo-entry",
        transformIndexHtml(html) {
          return useLocalDemo ? html.replace("/src/main.tsx", "/src/main.demo.tsx") : html;
        },
      },
      react(),
      tailwindcss(),
    ],
    build: { target: "es2024" },
  };
});
