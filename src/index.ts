// Public surface for a config file: `import { defineConfig } from 'jev-qa'`.
export { defineConfig } from './config.ts';
export type { CheckFn, Config, Environment, Known, Role } from './config.ts';
export type { ExpectAssertion, Phase, PhaseStart, Scenario } from './scenario.ts';
export { RUN_PLACEHOLDER } from './scenario.ts';
