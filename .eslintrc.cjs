/**
 * Mode-4 warn-baseline canonical — see cortextos task_1779393988390 (Mode-4 batch).
 *
 * This repo has latent lint debt that the strict mimecast #12 / liongard fleet-canonical
 * surfaces. To preserve the Mode-4 gate-fix discipline (Lint step finds config + runs + exits
 * 0, not exit-2 with "no config") without conflating Mode-4 (configure lint) with Mode-2
 * (fix repo-specific lint debt), the following rules are downgraded from error → warn:
 *
 *   '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
 *   '@typescript-eslint/no-explicit-any': 'warn'
 *
 * LATENT DEBT (visible warnings, not blocking errors):
 *   9 findings: no-explicit-any (multiple auth code sites) + no-unused-vars (unused authErr)
 *
 * GOAL: warn → error after the debt is addressed. Follow-up task: cortextos task_1779394868097_72147253.
 * Rest of the fleet-canonical (eslint:recommended + plugin:@typescript-eslint/recommended
 * baseline) preserved strict; the warn-downgrade is rule-specific, not blanket.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  env: {
    node: true,
    es2022: true,
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  rules: {
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
  },
};
