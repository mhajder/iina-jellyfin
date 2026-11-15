import js from '@eslint/js';

const timers = {
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
};

const sharedRules = {
  'no-useless-escape': 'off',
  'no-console': 'off', // IINA plugins use console.log for debugging
  'prefer-const': 'error',
  'no-var': 'error',
  eqeqeq: ['error', 'always'],
  curly: ['error', 'multi-line'],
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-shadow': 'error',
};

export default [
  js.configs.recommended,
  { rules: sharedRules },
  {
    files: ['src/**/*.js'],
    languageOptions: { ecmaVersion: 2020 },
  },
  {
    // Main plugin entries and runtime library (CommonJS, run by IINA's JavaScriptCore)
    files: ['src/index.js', 'src/global.js', 'src/lib/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        iina: 'readonly', // IINA plugin global
        ...timers, // Available in IINA plugin context
      },
    },
    rules: {
      strict: ['error', 'global'],
      'no-duplicate-imports': 'error',
    },
  },
  {
    // UI/sidebar files (browser environment)
    files: ['src/ui/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        iina: 'readonly', // IINA plugin global available in UI
        console: 'readonly',
        window: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        URLSearchParams: 'readonly',
        ...timers,
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^_' }],
    },
  },
  {
    // Tests (ES modules, run by node --test)
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: {
        URL: 'readonly',
        URLSearchParams: 'readonly',
        setImmediate: 'readonly',
        ...timers,
      },
    },
  },
];
