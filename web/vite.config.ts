import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: true },
      // The agent API, so the browser can drive it for the demo panel. In a
      // real deployment an outside agent calls the server directly and never
      // comes through here.
      "/v1": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
});
