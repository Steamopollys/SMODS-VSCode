// @ts-check
const tseslint = require("typescript-eslint");

module.exports = tseslint.config(
  { ignores: ["out/**", "dist/**", "**/*.d.ts"] },
  {
    files: ["src/**/*.ts"],
    extends: tseslint.configs.recommended,
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/naming-convention": [
        "warn",
        { selector: "import", format: ["camelCase", "PascalCase"] },
      ],
      curly: "warn",
      eqeqeq: "warn",
      "no-throw-literal": "warn",
      semi: "warn",
    },
  }
);
