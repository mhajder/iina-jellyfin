import { defineConfig } from 'vitest/config';

// Files added or changed by the offline downloads feature. Everything in this
// list must stay at 100% coverage; the thresholds below enforce it.
export const coveredFiles = [
  'src/index.js',
  'src/lib/download-profile.js',
  'src/lib/download-transport.js',
  'src/lib/offline-downloads.js',
  'src/lib/subtitle-utils.js',
  'src/ui/sidebar/sidebar.js',
  'src/ui/sidebar/lib/debug-log.js',
  'src/ui/sidebar/lib/media-methods.js',
  'src/ui/sidebar/lib/offline-methods.js',
];

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.js'],
    environment: 'node',
    restoreMocks: true,
    coverage: {
      provider: 'istanbul',
      all: true,
      include: coveredFiles,
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
