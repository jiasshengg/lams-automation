import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Loads the ignored .env so the sheet endpoint and secret reach process.env.
 *
 * The project has no dotenv dependency and the npm scripts pass no --env-file, so without
 * this a present .env is simply never read and the sheet sink reports the variables as
 * unset. Node's own parser is used, and real environment variables already exported by the
 * shell keep precedence, so CI can override the file.
 */
export function loadEnvFile(file = '.env'): void {
  const resolved = path.resolve(file);
  if (!existsSync(resolved)) return;
  const before = new Set(Object.keys(process.env));
  process.loadEnvFile(resolved);
  for (const key of before) {
    // process.loadEnvFile overwrites, so anything the shell set is restored afterwards.
    const original = originalEnv.get(key);
    if (original !== undefined) process.env[key] = original;
  }
}

const originalEnv = new Map(Object.entries(process.env).filter(([, value]) => value !== undefined) as Array<[string, string]>);
