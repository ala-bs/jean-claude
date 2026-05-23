import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve('src'),
      '@shared': resolve('shared'),
    },
  },
  test: {
    environment: 'node',
    include: ['shared/**/*.test.ts', 'electron/**/*.test.ts'],
  },
});
