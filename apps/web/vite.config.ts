import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  /* dev server: same-origin proxy to the truss server (REST + both WS) */
  server: {
    port: 4041,
    proxy: {
      "/health": "http://127.0.0.1:4040",
      "/api/terminal": { target: "http://127.0.0.1:4040", ws: true },
      "/api": "http://127.0.0.1:4040",
      "/events": { target: "ws://127.0.0.1:4040", ws: true },
    },
  },
});
