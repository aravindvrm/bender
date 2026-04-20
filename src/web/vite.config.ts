import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: "src/web",
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    target: ["chrome87", "firefox78", "safari14", "edge88"],
    // vendor-diagrams (mermaid + cytoscape + dagre) is intentionally large but
    // only loaded lazily when the user opens Architecture view.
    chunkSizeWarningLimit: 3000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Heavy diagram / math rendering — only loaded by ArchitectureView
          if (id.includes("node_modules/mermaid") || id.includes("node_modules/cytoscape") || id.includes("node_modules/dagre")) {
            return "vendor-diagrams";
          }
          // KaTeX math rendering
          if (id.includes("node_modules/katex")) {
            return "vendor-katex";
          }
          // Vercel AI SDK + streaming primitives
          if (id.includes("node_modules/ai") || id.includes("node_modules/@ai-sdk")) {
            return "vendor-ai";
          }
          // React core — always tiny, keep in main bundle
          if (id.includes("node_modules/react/") || id.includes("node_modules/react-dom/")) {
            return "vendor-react";
          }
        },
      },
    },
  },
  server: {
    port: 3141,
    proxy: {
      "/api": "http://localhost:3142",
    },
  },
});
