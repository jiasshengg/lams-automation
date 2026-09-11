import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { root } from './doctor.mjs';

export const localConfigPath = path.join(root, 'configs/local.json');

/** Playwright channels tried, in order, when the bundled Chromium cannot be installed on this OS. */
export const SYSTEM_BROWSER_CHANNELS = ['chrome', 'msedge'];

/** Reads configs/local.json, or an empty object when it does not exist yet. */
export function readLocalConfig(configPath = localConfigPath) {
  let text;
  try { text = readFileSync(configPath, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${configPath} must contain a JSON object.`);
  return parsed;
}

/** Returns the configured system browser channel (e.g. "chrome"), or undefined for the bundled Chromium. */
export function readBrowserChannel(configPath = localConfigPath) {
  const channel = readLocalConfig(configPath).browser?.channel;
  return typeof channel === 'string' && channel.trim() !== '' ? channel : undefined;
}

/** Records the system browser channel in configs/local.json, preserving every other setting. */
export function writeBrowserChannel(channel, configPath = localConfigPath) {
  const config = readLocalConfig(configPath);
  config.browser = { ...(config.browser ?? {}), channel };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}
