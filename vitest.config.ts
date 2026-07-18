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
    include: [
      'scripts/**/*.test.ts',
      'shared/**/*.test.ts',
      'electron/**/*.test.ts',
      'src/lib/**/*.test.ts',
      'src/hooks/**/*.test.ts',
      'src/cache/**/*.test.ts',
      'src/features/agent/ui-diff-view/**/*.test.ts',
      'src/features/agent/ui-markdown-content/**/*.test.ts',
      'src/features/agent/ui-message-stream/**/*.test.ts',
      'src/features/agent/ui-permission-bar/**/*.test.tsx',
      'src/features/agent/ui-question-options/**/*.test.tsx',
      'src/features/agent/task-message-manager/**/*.test.tsx',
      'src/features/agent/ui-worktree-actions/**/*.test.ts',
      'src/features/common/ui-inline-comments/**/*.test.ts',
      'src/features/common/ui-prompt-textarea/**/*.test.ts',
      'src/features/common/ui-mermaid-diagram/**/*.test.tsx',
      'src/features/common/ui-ai-skill-slot/**/*.test.tsx',
      'src/features/work-item/**/*.test.tsx',
      'src/features/project/ui-project-settings/**/*.test.ts',
      'src/features/project/ui-work-item-title-parser-settings/**/*.test.ts',
      'src/features/common/ui-video-gif-converter/**/*.test.ts',
      'src/features/new-task/ui-prompt-composer/**/*.test.ts',
      'src/features/pull-request/**/*.test.ts',
      'src/features/task/**/*.test.ts',
      'src/features/work-item/ui-azure-board-overlay/**/*.test.tsx',
      'src/features/work-item/ui-work-item-board/**/*.test.ts',
      'src/features/work-item/ui-parsed-work-item-title/**/*.test.tsx',
      'src/stores/**/*.test.ts',
    ],
    setupFiles: ['./vitest.setup.ts'],
  },
});
