import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: ["es2021", "safari13"],
    minify: "esbuild",
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("@xterm")) return "terminal";
          if (id.includes("lucide-react")) return "icons";
          if (id.includes("dompurify") || id.includes("marked")) return "markdown";
          if (id.includes("@tauri-apps")) return "tauri";
          if (id.includes("react")) return "react";
        },
      },
    },
  },
});
