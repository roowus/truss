import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 4041,
    proxy: {
      "/health": "http://localhost:4040",
      "/api": "http://localhost:4040",
      "/events": { target: "ws://localhost:4040", ws: true },
    },
  },
});
