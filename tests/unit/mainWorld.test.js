import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'fs';

const configSource = readFileSync(new URL('../../lib/config.js', import.meta.url), 'utf8');
const serverSource = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');

describe('main-world evaluate (opt-in)', () => {
  test('config reads CAMOFOX_ALLOW_MAIN_WORLD and workarounds.allowMainWorld, defaulting off', () => {
    expect(configSource).toContain("process.env.CAMOFOX_ALLOW_MAIN_WORLD === '1'");
    expect(configSource).toContain('workarounds?.allowMainWorld');
    expect(configSource).toContain('allowMainWorld,');
  });

  test('launch passes main_world_eval AND disableWorldIsolation (the latter is required)', () => {
    // Only main_world_eval is not enough on Camoufox v152; both must be present.
    expect(serverSource).toMatch(/main_world_eval:\s*true/);
    expect(serverSource).toMatch(/disableWorldIsolation:\s*true/);
    // and it must be gated on the config flag, not unconditional
    expect(serverSource).toMatch(/CONFIG\.allowMainWorld\s*\n?\s*\?\s*\{/);
  });

  test('evaluate-main route exists and refuses when disabled', () => {
    expect(serverSource).toContain("app.post('/tabs/:tabId/evaluate-main'");
    expect(serverSource).toContain("code: 'main_world_disabled'");
    expect(serverSource).toMatch(/409/);
  });

  test('launch logs a warning when main-world is on', () => {
    expect(serverSource).toMatch(/main-world evaluate is ENABLED/);
  });
});
