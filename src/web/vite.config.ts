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
  },
  server: {
    port: 3141,
    proxy: {
      "/api": "http://localhost:3142",
    },
  },
});
