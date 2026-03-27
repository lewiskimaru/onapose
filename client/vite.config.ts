import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@onapose/shared": path.resolve(__dirname, "../shared/src/index.ts"),
    },
  },
  server: {
    port: 5173,
  },
  build: {
    // Three.js and R3F are inherently large — 700KB is expected for a 3D app
    chunkSizeWarningLimit: 750,
    rollupOptions: {
      output: {
        manualChunks: {
          "three-core":   ["three"],
          "r3f":          ["@react-three/fiber", "@react-three/drei"],
          "three-vrm":    ["@pixiv/three-vrm"],
          "kalidokit":    ["kalidokit"],
          "react-vendor": ["react", "react-dom"],
        },
      },
    },
  },
});
