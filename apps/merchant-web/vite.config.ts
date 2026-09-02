import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { shouldUseLocalMerchantDemoEntry } from "./src/merchant-demo-entry.js";

export default defineConfig(({ command }) => {
  const useLocalDemo = shouldUseLocalMerchantDemoEntry(command, process.env.VITE_BOP_LOCAL_DEMO);
  return {
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
