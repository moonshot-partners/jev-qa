// Minimal .env loader. Sets process.env[K] only when K is not already set, so
// real environment variables always win over a checked-in default. Never logs values.
import { existsSync, readFileSync } from 'node:fs';

export function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] ??= m[2];
  }
}
