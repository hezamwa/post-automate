import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // Local dev: the Worker runs on :8787 (wrangler dev); same-origin in production
    // (dashboard hosted alongside the Worker, OD-17).
    proxy: {
      "/auth": "http://localhost:8787",
      "/admin": "http://localhost:8787",
    },
  },
});
