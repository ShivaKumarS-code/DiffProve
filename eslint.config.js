import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // apps/web has its own toolchain (Next.js + Tailwind) and is excluded from
  // the service's lint run; its build (`npm run build -w apps/web`) is its gate.
  { ignores: ['dist/', 'coverage/', 'node_modules/', 'apps/web/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
);
