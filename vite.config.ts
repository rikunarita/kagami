import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    minify: "esbuild",
    cssMinify: true,
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("satoru-render")) return "satoru";
          if (id.includes("@jsquash")) return "jsquash";
        },
      },
    },
  },
  worker: {
    format: "es",
    rollupOptions: {
      output: { manualChunks: undefined },
    },
  },
  server: { port: 5199 },
  preview: { port: 5199 },
});
