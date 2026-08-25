import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import dts from "vite-plugin-dts";

/**
 * ESM build. React is externalized (declared as a peer dependency) so that a
 * consuming React app dedupes to a single React instance — otherwise hooks
 * throw "invalid hook call". Everything else (the vendored SDK, the markdown
 * stack) is bundled in.
 *
 * CSS is imported with `?inline` in source, so Vite emits no `.css` asset and
 * injects nothing into document.head — the widget injects it into its shadow
 * root at runtime instead.
 */
export default defineConfig({
  plugins: [
    react(),
    dts({ rollupTypes: true, include: ["src"] }),
  ],
  // Dev-only: `npm run dev` opens the inline demo. Ignored by `vite build`.
  server: {
    open: "/demo/",
  },
  build: {
    target: "es2019",
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      formats: ["es"],
      fileName: () => "index.mjs",
    },
    rollupOptions: {
      external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
    },
  },
});
