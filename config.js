/**
 * Loads required configuration from environment variables.
 * Nothing sensitive is ever hardcoded in source. Copy .env.example to .env
 * and fill in your own keys; .env is gitignored so it never gets committed.
 */
import { readFileSync, existsSync } from 'node:fs';

export function loadEnv(path = '.env') {
  if (!existsSync(path)) return;
  const raw = readFileSync(path, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = value;
  }
}

export function requireEnv(name, hint) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}.\n` +
        (hint || `Add it to your .env file (see .env.example).`)
    );
  }
  return value;
}

export function optionalEnv(name, fallback = null) {
  return process.env[name] || fallback;
}
