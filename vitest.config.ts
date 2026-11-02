import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      // Components inside WidgetShell (InputBar/Response/QuestionPills/Markdown)
      // are only exercised via a mounted UMD + live SCRT2 session — no isolated
      // tests exist for them today. The 90%/80% thresholds target the logic
      // we DO unit-test (provider, SDK, custom element, shim).
      exclude: [
        "src/components/InputBar.tsx",
        "src/components/Response.tsx",
        "src/components/QuestionPills.tsx",
        "src/components/Markdown.tsx",
        "src/components/icons.tsx",
      ],
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 90,
        lines: 90,
      },
    },
  },
});
