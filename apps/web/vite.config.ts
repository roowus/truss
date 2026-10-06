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
  /* dev server: same-origin proxy to the truss server (REST + both WS).
     TRUSS_SERVER_URL overrides the target — per-PR preview environments
     (pr-preview/Tiltfile) run a server on a per-PR port. */
  server: {
    port: Number(process.env.TRUSS_WEB_PORT ?? 4041),
    /* PR previews serve vite behind pr-<N>.truss.rewis — allow the suffix
       (vite 6 blocks unknown Host headers by default) */
    allowedHosts: [".truss.rewis"],
    proxy: (() => {
      const srv = process.env.TRUSS_SERVER_URL ?? "http://127.0.0.1:4040";
      return {
        "/health": srv,
        "/api/terminal": { target: srv, ws: true },
        "/api": srv,
        "/events": { target: srv.replace(/^http/, "ws"), ws: true },
        /* the server's own standalone routes (issue #164): the pairing
           landing page and the installer script it hands out — without
           these the preview domain serves the SPA fallback for /p and
           the pairing flow can't be exercised there */
        "/i": srv,
        "/p": srv,
      };
    })(),
  },
});
