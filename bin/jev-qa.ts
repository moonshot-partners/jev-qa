#!/usr/bin/env node
// jev-qa CLI. See README.md for the full command reference. Argument
// parsing and exit-code rules live in src/cli.ts as pure, tested functions;
// this file only wires them to argv, I/O and process.exit.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyWorkloadCode, exitCodeForCounts, flag, flagAll, hasFlag, parseCount, positionals, USAGE } from '../src/cli.ts';
import { loadConfig } from '../src/config.ts';
import { loadDotEnv } from '../src/env.ts';
import { replayRun, replayUrls } from '../src/replay.ts';
import { renderReport, summarize } from '../src/report.ts';
import { runAll, type Result } from '../src/runner.ts';
import { loadScenarios } from '../src/scenario.ts';

function usageExit(msg?: string): never {
  if (msg) console.error(msg);
  console.error(USAGE);
  process.exit(2);
}

function summaryLine(counts: Record<string, number>, extra?: string): string {
  const line = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ');
  return extra ? `${line} · ${extra}` : line;
}

async function runCommand(rest: string[]): Promise<void> {
  const configPath = flag(rest, '--config');
  const envName = flag(rest, '--env');
  if (!configPath || !envName) usageExit('run requires --config <path> and --env <name>');
  const { config, dir } = await loadConfig(configPath);
  if (!(envName in config.environments)) usageExit(`no environment named "${envName}" in config.environments`);

  let scenarios = loadScenarios(config, dir);
  const kindFilter = flag(rest, '--kind');
  if (kindFilter) scenarios = scenarios.filter((s) => s.kind === kindFilter);
  const filter = flag(rest, '--filter');
  if (filter) scenarios = scenarios.filter((s) => s.name.includes(filter));
  const names = flagAll(rest, '--name');
  if (names.length) scenarios = scenarios.filter((s) => names.includes(s.name));

  if (hasFlag(rest, '--list')) {
    for (const s of scenarios) console.log(`${s.kind} ${s.name} ${s.role ?? 'anon'} ${s.start}`);
    process.exit(0);
  }

  const allowEmpty = hasFlag(rest, '--allow-empty');
  const emptyCode = emptyWorkloadCode(scenarios.length, allowEmpty);
  if (emptyCode !== null) {
    console.error(`no scenarios matched (--kind ${kindFilter ?? 'any'}, --filter ${filter ?? '(none)'}, --name ${names.length ? names.join(',') : '(none)'})`);
    process.exit(emptyCode);
  }

  loadDotEnv(join(dir, '.env'));
  if (!process.env.TYPESAFE_API_KEY) {
    usageExit(`TYPESAFE_API_KEY is not set (checked the environment and ${join(dir, '.env')}); jev-qa run needs it to call Jev.`);
  }

  let concurrency: number;
  let repeat: number;
  try {
    concurrency = parseCount(flag(rest, '--concurrency'), 4, 'concurrency');
    repeat = parseCount(flag(rest, '--repeat'), 1, 'repeat');
  } catch (e) {
    usageExit((e as Error).message);
  }

  const out = flag(rest, '--out');
  const results = await runAll({ config, dir, envName, scenarios, concurrency, repeat, outDir: out });
  const { counts, inputTokens } = summarize(results);
  console.log(`verdicts: ${summaryLine(counts, `${inputTokens} Jev input tokens`)}`);
  process.exit(exitCodeForCounts(counts));
}

async function replayCommand(rest: string[]): Promise<void> {
  const configPath = flag(rest, '--config');
  const envName = flag(rest, '--env');
  if (!configPath || !envName) usageExit('replay requires --config <path> and --env <name>');
  const { config, dir } = await loadConfig(configPath);

  const role = flag(rest, '--role');
  const pos = positionals(rest, ['--config', '--env', '--role']);
  if (role !== undefined) {
    if (pos.length === 0) usageExit('replay --config --env --role <role> needs at least one url');
    await replayUrls({ config, envName, role, urls: pos });
  } else {
    const [runDir, scenarioName] = pos;
    if (!runDir || !scenarioName) usageExit('replay needs <run-dir> <scenario-name>, or --role <role> <url...>');
    await replayRun({ config, dir, envName, runDir, scenarioName });
  }
  process.exit(0);
}

function reportCommand(rest: string[]): void {
  const [runDir] = rest;
  if (!runDir) usageExit('report requires <run-dir>');
  const resultsPath = join(runDir, 'results.json');
  const results = JSON.parse(readFileSync(resultsPath, 'utf8')) as Result[];
  renderReport(results, runDir);
  const { total, counts, inputTokens } = summarize(results);
  console.log(`${total} runs · ${summaryLine(counts, `${inputTokens} Jev input tokens`)}`);
  process.exit(0);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) usageExit();
  if (command === 'run') return runCommand(rest);
  if (command === 'replay') return replayCommand(rest);
  if (command === 'report') return reportCommand(rest);
  usageExit(`unknown command "${command}"`);
}

await main();
