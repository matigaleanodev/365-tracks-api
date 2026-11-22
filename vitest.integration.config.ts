import { defineConfig } from 'vitest/config';

/** Suite contra DynamoDB Local: solo se lanza con `npm run test:integration` (necesita Docker). */
export default defineConfig({
  test: {
    include: ['test-integration/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['test-integration/support/global-setup.ts'],
    // Cada archivo crea y borra su tabla; en serie se evita competir por CPU con los procesos hijos.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
