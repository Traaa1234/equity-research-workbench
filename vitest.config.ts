import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**', 'tests/e2e/**', 'node_modules/**'],
    environment: 'node',
    globals: false,
    setupFiles: ['tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['**/__fixtures__/**', '**/*.test.ts', 'scripts/**']
    }
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') }
  }
});
