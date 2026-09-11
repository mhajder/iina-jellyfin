import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    // Main plugin files
    files: ['src/index.js', 'src/global.js'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        global: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        iina: 'readonly', // IINA plugin global
        setTimeout: 'readonly', // Available in IINA plugin context
        clearTimeout: 'readonly', // Available in IINA plugin context
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^lastItemId$' }],
      'no-useless-escape': 'off',
      'no-console': 'off', // IINA plugins use console.log for debugging
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always'],
      curly: ['error', 'multi-line'],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      strict: ['error', 'global'],
      'no-shadow': 'error',
      'no-redeclare': 'error',
      'no-duplicate-imports': 'error',
    },
  },
  {
    // Main plugin runtime library files (CommonJS)
    files: ['src/lib/**/*.js'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'script',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        global: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        iina: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^lastItemId$' }],
      'no-useless-escape': 'off',
      'no-console': 'off',
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always'],
      curly: ['error', 'multi-line'],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      strict: ['error', 'global'],
      'no-shadow': 'error',
      'no-redeclare': 'error',
    },
  },
  {
    // UI/sidebar files
    files: ['src/ui/**/*.js'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'script', // Browser environment
      globals: {
        console: 'readonly',
        window: 'readonly',
        document: 'readonly',
        http: 'readonly', // Global HTTP client (like main plugin)
        fetch: 'readonly', // Browser fetch API
        btoa: 'readonly',
        atob: 'readonly',
        URLSearchParams: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        iina: 'readonly', // IINA plugin global available in UI
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^_' }],
      'no-useless-escape': 'off',
      'no-console': 'off',
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always'],
      curly: ['error', 'multi-line'],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-shadow': 'error',
      'no-redeclare': 'error',
    },
  },
];
