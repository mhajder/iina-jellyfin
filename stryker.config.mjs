// Mutation testing for the files covered by the unit suite. A surviving mutant
// means a change to the code that no test noticed; the break threshold fails
// CI when too many survive.
import { coveredFiles } from './vitest.config.mjs';

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: {
    configFile: 'vitest.config.mjs',
  },
  mutate: coveredFiles,
  coverageAnalysis: 'perTest',
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/report.json' },
  thresholds: { high: 95, low: 85, break: 85 },
  tempDirName: '.stryker-tmp',
  cleanTempDir: 'always',
  timeoutMS: 15000,
  timeoutFactor: 2,
  ignorePatterns: ['coverage', 'reports', 'tests/e2e/.artifacts', 'node_modules/.cache'],
};
