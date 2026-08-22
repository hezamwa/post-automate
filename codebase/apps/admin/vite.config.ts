import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Local Worker by default; ADMIN_API_TARGET overrides (e.g. the staging URL).
// In production the dashboard is hosted same-origin alongside the Worker (OD-17).
const target = process.env.ADMIN_API_TARGET ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/auth": { target, changeOrigin: true },
      "/admin": { target, changeOrigin: true },
    },
  },
});
