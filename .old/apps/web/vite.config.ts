import tailwindcss from "@tailwindcss/vite";
import { identity } from "@mikan-919/oriel-identity";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/app/",
  plugins: [
    tailwindcss(),
    react(),
    {
      // 表示名の正本はpackages/identityに置き、HTMLへはbuild時に差し込む。
      name: "identity-display-name",
      transformIndexHtml: (html: string) =>
        html.replaceAll("%DISPLAY_NAME%", identity.displayName),
    },
  ],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
});
