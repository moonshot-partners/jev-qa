// Config types + loader. A config file is a plain ESM module whose default
// export is built with defineConfig(); loadConfig() dynamic-imports it.
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { APIRequestContext, BrowserContext, Page } from 'playwright';
import type { Scenario } from './scenario.ts';

export type Environment = { baseUrl: string; mutations: boolean };

// login receives a fresh page in the scenario's context; it must leave the
// context authenticated. Anonymous roles: `login: async () => {}`, or a
// scenario can pass `role: null` to skip login entirely.
//
// baseUrl can derive from the environment — e.g. a per-tenant subdomain
// that differs between staging and local — instead of one static string
// that can't serve both. Resolve it with resolveBaseUrl(), never by reading
// role.baseUrl directly.
export type Role = { baseUrl?: string | ((env: Environment) => string); login: (page: Page, env: Environment) => Promise<void> };

// PURE: a role with no baseUrl falls back to the environment's; a function
// baseUrl is called with the environment to resolve it per env.
export function resolveBaseUrl(role: Role, env: Environment): string {
  if (role.baseUrl === undefined) return env.baseUrl;
  return typeof role.baseUrl === 'function' ? role.baseUrl(env) : role.baseUrl;
}

// matched against finding.detail (and kind when given).
export type Known = { id: string; match: RegExp; kind?: RegExp };

export type CheckFn = (
  ctx: { env: Environment; role: string | null; page: Page; request: APIRequestContext },
  args: unknown,
) => Promise<{ ok: boolean; detail: string; url?: string }>;
// `url` (optional) lets a check also serve as a phase START (see Scenario.then): a check that
// e.g. reads a mailbox and returns the link it found. Ignored by `expect` assertions.

export type Config = {
  environments: Record<string, Environment>;
  roles: Record<string, Role>;
  ownOrigins: RegExp[]; // response host matches any → own-origin
  noise?: RegExp[]; // appended to DEFAULT_NOISE; matching finding detail is never recorded
  known?: Known[]; // finding kept in report as `known:<id> <kind>`, does not fail the run
  crashText?: RegExp[]; // appended to DEFAULT_CRASH_TEXT
  // Runs on each fresh browser context BEFORE login and BEFORE the start navigation. Use it for
  // safety rails that must cover every request of the run, e.g. a context.route() guard that
  // aborts navigation outside the target environment (beforeEach runs only after the start page
  // has loaded, so a guard installed there cannot cover the start URL). Does not cover
  // APIRequestContext calls (ctx.request, used by checks and replay), which bypass routes.
  setupContext?: (ctx: BrowserContext, env: Environment) => Promise<void>;
  // Applied to every request the engine sends itself, outside the browser (replay's
  // APIRequestContext calls, which bypass setupContext routes). Return the URL to send, possibly
  // rewritten, or { refuse: reason } to skip it. Keep it consistent with setupContext's rails.
  guardRequest?: (url: string, env: Environment) => string | { refuse: string };
  beforeEach?: (page: Page) => Promise<void>; // after start navigation, before step 1
  smoke?: () => Scenario[]; // generated scenarios, kind forced to 'smoke'
  checks?: Record<string, CheckFn>;
  // Round 8 (N2): extra secret strings the app config knows about that can appear ON THE PAGE
  // itself (e.g. a logged-in role's own email/password shown in an account settings field) —
  // these aren't scenario `inputs`, so buildBody() has no per-input key to redact them
  // by; every one of them redacts to the single shared «secret» token instead. A function is
  // resolved fresh per decide() call (see the runner), for a config that only has the values
  // available lazily (e.g. read from a fixture file at run time).
  redact?: string[] | (() => string[]);
  scenarios: string | string[]; // glob(s) relative to the config file dir
};

export function defineConfig(c: Config): Config {
  return c;
}

function validate(config: Config): void {
  if (!config.environments || Object.keys(config.environments).length === 0) {
    throw new Error('config.environments must be a non-empty object of { [name]: Environment }');
  }
  if (!config.roles || typeof config.roles !== 'object') {
    throw new Error('config.roles must be an object of { [name]: Role }');
  }
  for (const [name, role] of Object.entries(config.roles)) {
    if (!role || typeof role.login !== 'function') {
      throw new Error(`config.roles.${name}.login must be a function`);
    }
  }
  if (!Array.isArray(config.ownOrigins) || config.ownOrigins.length === 0 || !config.ownOrigins.every((r) => r instanceof RegExp)) {
    throw new Error('config.ownOrigins must be a non-empty array of RegExp');
  }
  const scenarios = config.scenarios;
  const scenariosOk = typeof scenarios === 'string' ? scenarios.length > 0 : Array.isArray(scenarios) && scenarios.length > 0;
  if (!scenariosOk) {
    throw new Error('config.scenarios must be a non-empty string or array of strings (glob patterns)');
  }
}

// Strips the global/sticky flags off a RegExp. A `g`/`y` regex is
// stateful (its `.lastIndex` advances across `.test()` calls), so the same
// RegExp instance reused across many findings/responses would silently
// alternate match/no-match. Every regex a config supplies for matching
// (never for anything order-dependent) is normalized through this.
export function stripStatefulFlags(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags.replace(/[gy]/g, ''));
}

function normalizeRegexes(config: Config): void {
  config.ownOrigins = config.ownOrigins.map(stripStatefulFlags);
  if (config.noise) config.noise = config.noise.map(stripStatefulFlags);
  if (config.crashText) config.crashText = config.crashText.map(stripStatefulFlags);
  if (config.known) {
    config.known = config.known.map((k) => ({ ...k, match: stripStatefulFlags(k.match), kind: k.kind ? stripStatefulFlags(k.kind) : undefined }));
  }
}

export async function loadConfig(path: string): Promise<{ config: Config; dir: string }> {
  const abs = resolve(path);
  const mod = (await import(pathToFileURL(abs).href)) as { default?: Config };
  const config = mod.default;
  if (!config) throw new Error(`${abs} has no default export; use defineConfig({ ... }) and export default`);
  validate(config);
  normalizeRegexes(config);
  return { config, dir: dirname(abs) };
}

// A minimal glob: '*' matches within one path segment, '**' matches the
// current directory and any depth of subdirectories. No other glob syntax
// (no brace expansion, no character classes). Returns absolute file paths.
export function glob(pattern: string, root: string): string[] {
  const segments = pattern.split('/').filter((s) => s.length > 0);
  const results: string[] = [];

  function segToRegExp(seg: string): RegExp {
    const escaped = seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`);
  }

  function walk(dir: string, segIndex: number): void {
    if (segIndex >= segments.length) return;
    const seg = segments[segIndex];
    const isLast = segIndex === segments.length - 1;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    if (seg === '**') {
      // Zero directories consumed: try the rest of the pattern here too.
      walk(dir, segIndex + 1);
      for (const entry of entries) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, segIndex);
      }
      return;
    }
    const re = segToRegExp(seg);
    for (const entry of entries) {
      if (!re.test(entry)) continue;
      const full = join(dir, entry);
      const isDir = statSync(full).isDirectory();
      if (isLast) {
        if (!isDir) results.push(full);
      } else if (isDir) {
        walk(full, segIndex + 1);
      }
    }
  }

  walk(root, 0);
  return results.sort();
}
