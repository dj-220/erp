import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the web app runs on 5173 and forwards /api to the API on 3000.
// In production the API serves the built files itself, so there is only one address.
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
  server: { port: 5173, proxy: { "/api": { target: "http://localhost:3000", changeOrigin: false } } },
});
