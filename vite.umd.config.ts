import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * UMD build. React is bundled in so the output is a self-contained <script>
 * that works on any page (CDN / unpkg / non-React hosts). Runs as a second
 * pass with `emptyOutDir: false` so it doesn't wipe the ESM output + types.
 *
 * `process.env.NODE_ENV` is replaced surgically (not the whole `process.env`
 * object) so React's production build is selected without shipping a broken
 * `process` shim.
 */
export default defineConfig({
  plugins: [react()],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    target: "es2019",
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "InlineAgentWidget",
      formats: ["umd"],
      fileName: () => "inline-agent-widget.umd.js",
    },
  },
});
