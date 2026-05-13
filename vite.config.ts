import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    watch: {
      // Don't watch the Rust backend source from the Vite side.
      ignored: ["**/src-tauri/**"],
    },
  },
  // Produce smaller bundles / browser-target.
  build: {
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
  },
  // Tauri sets TAURI_DEBUG in dev.
  envPrefix: ["VITE_", "TAURI_"],
}));
