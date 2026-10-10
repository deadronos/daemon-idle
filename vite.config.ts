import { defineConfig, type UserConfig } from "vite-plus";

// oxlint config, run via `vp lint`. `typeAware`/`typeCheck` enable the
// Go-based type-aware pass (oxlint-tsgolint), which is what works with TS 7.
const lintConfig = {
  plugins: ["oxc", "typescript", "unicorn"],
  categories: { correctness: "warn" },
  env: { builtin: true },
  ignorePatterns: ["node_modules", "dist", "coverage"],
  options: { typeAware: true, typeCheck: true },
  overrides: [
    {
      files: ["**/*.{ts,mts,cts}"],
      rules: {
        "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
        "no-redeclare": "off",
      },
    },
  ],
};

const fmtConfig = {
  ignorePatterns: ["node_modules", "dist", "coverage"],
};

export default defineConfig({
  fmt: fmtConfig,
  lint: lintConfig,
  test: {
    include: ["src/**/*.{test,spec}.ts"],
    environment: "node",
    globals: false,
    watch: false,
  },
} as UserConfig & {
  fmt: typeof fmtConfig;
  lint: typeof lintConfig;
});
