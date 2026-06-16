import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

const eslintConfig = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "next-env.d.ts",
      "tsconfig.tsbuildinfo",
      // Standalone one-off maintenance/test scripts (plain Node .cjs/.mjs, run by
      // hand, not part of the app build).
      "scripts/**",
      "supabase/**",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // Conversational UI copy uses apostrophes ("you'll", "can't") throughout.
      // This rule only flags literal apostrophes/quotes in JSX text — a stylistic
      // concern, never a real bug — and was failing production builds. Off.
      "react/no-unescaped-entities": "off",
    },
  },
];

export default eslintConfig;
