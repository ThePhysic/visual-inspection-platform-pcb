import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

/** Resolve the literal checkout override with Compose's shell > .env > default precedence. */
export async function resolveDlDirectory({ projectRoot, environment = process.env }) {
  // Custom dotenv sources would make a standalone preflight inspect a different
  // checkout from Compose. Fail closed rather than silently ignoring them.
  if (environment.COMPOSE_ENV_FILES || environment.COMPOSE_DISABLE_ENV_FILE) {
    throw new Error('Release verification supports the project .env and exported DL_REPOSITORY_DIR; custom Compose env-file settings are unsupported.');
  }
  let fromFile = {};
  try { fromFile = parseEnv(await readFile(resolve(projectRoot, '.env'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const fromShell = environment.DL_REPOSITORY_DIR;
  const selected = fromShell !== undefined ? fromShell : fromFile.DL_REPOSITORY_DIR;
  if (selected !== undefined && typeof selected !== 'string') throw new Error('DL_REPOSITORY_DIR must be a directory path.');
  if (fromShell === undefined && selected?.includes('$')) {
    throw new Error('DL_REPOSITORY_DIR in .env must be a literal path without variable interpolation; use an expanded exported path instead.');
  }
  // ${VAR:-default} in Compose chooses the default for both unset and empty values.
  const configured = selected || '../visual-inspection-dl';
  const expanded = configured === '~' ? homedir()
    : /^~[\\/]/.test(configured) ? resolve(homedir(), configured.slice(2)) : configured;
  return resolve(projectRoot, expanded);
}
