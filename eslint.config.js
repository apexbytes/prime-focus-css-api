import js from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

/** `{ element: { type } }` selector, optionally scoped to captured values. */
const el = (type, captured) => ({ element: captured ? { type, captured } : { type } });

/** Any of several element types. */
const anyOf = (...types) => ({ element: { types: { anyOf: types } } });

/** The same module's file of a given layer — never another module's internals. */
const own = (type) => el(type, { module: '{{from.module}}' });

const allow = (...selectors) => selectors.map((to) => ({ to }));

/**
 * Architectural boundaries are enforced here rather than by convention, because
 * the layering in docs/api-structure.md only survives if a violation fails CI.
 *
 * Layers:  config → common/lib → db → modules → routes/workers → app
 * Modules: routes → controller → service → repository → model
 *          (a controller may not reach a repository; a repository may not call a
 *           service; cross-module traffic goes service → service)
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'drizzle/**', 'node_modules/**', '.idea/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',
      curly: ['error', 'multi-line'],
    },
  },
  {
    files: ['src/**/*.ts'],
    plugins: { boundaries },
    settings: {
      // Relative specifiers are written with the ESM '.js' extension while the
      // sources are '.ts'; the default node resolver cannot bridge that.
      'import/resolver': {
        typescript: { project: './tsconfig.json' },
      },
      // NOTE: eslint-plugin-boundaries deprecates `mode` in favour of
      // `partialMatch`, but `partialMatch: false` does not reproduce
      // `mode: 'file'` (elements stop matching), so file-level elements keep
      // using `mode` until the plugin documents the replacement.
      'boundaries/include': ['src/**/*.ts'],
      'boundaries/elements': [
        // File-level module layers first — the first match wins.
        {
          type: 'module-test',
          pattern: 'src/modules/*/*.test.ts',
          mode: 'file',
          capture: ['module'],
        },
        {
          type: 'module-index',
          pattern: 'src/modules/*/index.ts',
          mode: 'file',
          capture: ['module'],
        },
        {
          type: 'module-routes',
          pattern: 'src/modules/*/*.routes.ts',
          mode: 'file',
          capture: ['module'],
        },
        {
          type: 'module-controller',
          pattern: 'src/modules/*/*.controller.ts',
          mode: 'file',
          capture: ['module'],
        },
        {
          type: 'module-service',
          pattern: 'src/modules/*/*.service.ts',
          mode: 'file',
          capture: ['module'],
        },
        {
          type: 'module-repository',
          pattern: 'src/modules/*/*.repository.ts',
          mode: 'file',
          capture: ['module'],
        },
        {
          type: 'module-model',
          pattern: 'src/modules/*/*.model.ts',
          mode: 'file',
          capture: ['module'],
        },
        {
          type: 'module-jobs',
          pattern: 'src/modules/*/*.jobs.ts',
          mode: 'file',
          capture: ['module'],
        },
        {
          type: 'module-middleware',
          pattern: 'src/modules/*/*.middleware.ts',
          mode: 'file',
          capture: ['module'],
        },
        {
          type: 'module-shared',
          pattern: 'src/modules/*/*.{schema,types,events,policy,mapper,status}.ts',
          mode: 'file',
          capture: ['module'],
        },
        // Layers.
        { type: 'config', pattern: 'src/config/**/*.ts', mode: 'file' },
        { type: 'common', pattern: 'src/common/**/*.ts', mode: 'file' },
        { type: 'lib', pattern: 'src/lib/**/*.ts', mode: 'file' },
        { type: 'db', pattern: 'src/db/**/*.ts', mode: 'file' },
        { type: 'routes', pattern: 'src/routes/**/*.ts', mode: 'file' },
        { type: 'workers', pattern: 'src/workers/**/*.ts', mode: 'file' },
        { type: 'app', pattern: 'src/*.ts', mode: 'file' },
      ],
    },
    rules: {
      'boundaries/no-unknown-dependencies': 'error',
      'boundaries/no-unknown-files': 'error',
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          policies: [
            { from: el('config'), allow: allow(el('config')) },
            { from: el('common'), allow: allow(anyOf('config', 'common', 'lib', 'db')) },
            { from: el('lib'), allow: allow(anyOf('config', 'common', 'lib')) },
            // schema.ts barrels every module model, so db may reach models only.
            {
              from: el('db'),
              allow: allow(anyOf('config', 'common', 'lib', 'db'), el('module-model')),
            },

            {
              from: el('module-routes'),
              allow: allow(
                anyOf('config', 'common'),
                // Route files wire middleware, including another module's
                // authenticate/authorize exposed through its barrel, and mount
                // another module's router as a nested resource
                // (/tickets/:id/messages).
                anyOf('module-index', 'module-middleware', 'module-routes'),
                own('module-controller'),
                own('module-shared'),
              ),
            },
            {
              from: el('module-middleware'),
              allow: allow(
                anyOf('config', 'common', 'lib', 'module-service'),
                own('module-shared'),
              ),
            },
            {
              from: el('module-controller'),
              allow: allow(
                anyOf('config', 'common', 'lib'),
                own('module-service'),
                own('module-shared'),
              ),
            },
            {
              from: el('module-service'),
              allow: allow(
                anyOf('config', 'common', 'lib', 'db'),
                // Cross-module traffic is service → service or via the barrel,
                // never into another module's repository. `module-shared` is the
                // type-only surface (DTOs) of another module.
                anyOf('module-service', 'module-index', 'module-shared'),
                own('module-repository'),
                own('module-model'),
                own('module-shared'),
              ),
            },
            {
              from: el('module-repository'),
              allow: allow(
                anyOf('config', 'common', 'lib', 'db'),
                // Any module's model: a repository joins tables, and one schema
                // in one database is the whole point of a modular monolith.
                // Still forbidden: another module's repository or service.
                el('module-model'),
                own('module-shared'),
              ),
            },
            // Foreign keys legitimately reference other modules' tables.
            {
              from: el('module-model'),
              allow: allow(anyOf('config', 'common', 'db'), el('module-model')),
            },
            {
              from: el('module-jobs'),
              allow: allow(
                anyOf('config', 'common', 'lib', 'db', 'module-service'),
                own('module-shared'),
              ),
            },
            {
              from: el('module-shared'),
              allow: allow(
                anyOf('config', 'common', 'lib', 'db'),
                // Another module's DTOs, for composed response types.
                el('module-shared'),
                // A types file re-exports its own module's inferred row types.
                own('module-model'),
              ),
            },
            {
              from: el('module-index'),
              allow: allow(
                anyOf('config', 'common'),
                own('module-routes'),
                own('module-service'),
                own('module-jobs'),
                own('module-middleware'),
                own('module-shared'),
                own('module-model'),
              ),
            },
            { from: el('module-test'), allow: allow({ element: { type: '*' } }) },

            {
              from: el('routes'),
              allow: allow(anyOf('config', 'common', 'lib', 'module-index', 'routes')),
            },
            {
              from: el('workers'),
              allow: allow(anyOf('config', 'common', 'lib', 'db', 'module-index', 'module-jobs')),
            },
            {
              from: el('app'),
              allow: allow(
                anyOf('config', 'common', 'lib', 'db', 'module-index', 'routes', 'workers', 'app'),
              ),
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', 'tests/**/*.ts'],
    rules: {
      // Tests deliberately build malformed payloads and poke at internals.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  {
    files: ['src/db/migrate.ts', 'src/db/seed.ts', 'src/db/seeds/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.d.ts'],
    rules: {
      // A global augmentation file must stay non-module, so inline `import()`
      // type references are the only option.
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
  // Config files live outside the typed program.
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
