/**
 * Unit tests for the login-guard plugin + lib/verification.js helpers.
 *
 * Run with: npx jest plugins/login-guard
 *
 * No browser: `page` is a small fake; the plugin is exercised through a fake
 * Express app so route registration + response shaping are covered.
 */
import { describe, test, expect, jest } from '@jest/globals';
import {
  COLOR_MODES,
  DIALOG_POLICIES,
  MAX_DOMAIN_POLICIES,
  colorDistance,
  computeGapMatch,
  dialogDecision,
  findChallengeWidgets,
  findPuzzleGap,
  findTabState,
  installDialogHandler,
  matchHostPolicy,
  matchHostPolicyKey,
  normalizeColorMode,
  normalizeDialogPolicy,
  normalizeHost,
  parsePolicyDomain,
  resolveDialogPolicy,
  sobelEdgeMap,
  summarizeDialog,
  validatePolicyDomain,
} from '../../lib/verification.js';

function fakePage(overrides = {}) {
  const listeners = new Map();
  return {
    on: jest.fn((event, fn) => { listeners.set(event, fn); }),
    off: jest.fn((event) => { listeners.delete(event); }),
    emit: async (event, arg) => { const fn = listeners.get(event); if (fn) await fn(arg); },
    evaluate: jest.fn(async () => ({ url: 'https://x', title: 't', count: 0, challenges: [] })),
    url: () => 'https://x',
    ...overrides,
  };
}

describe('dialog policy helpers', () => {
  test('normalizeDialogPolicy accepts known values and falls back', () => {
    expect(DIALOG_POLICIES).toEqual(['dismiss', 'accept', 'auto']);
    expect(normalizeDialogPolicy('accept')).toBe('accept');
    expect(normalizeDialogPolicy('bogus')).toBe('dismiss');
    expect(normalizeDialogPolicy('bogus', 'auto')).toBe('auto');
  });

  test('dialogDecision honors policy and always accepts beforeunload', () => {
    expect(dialogDecision('confirm', 'dismiss')).toBe('dismiss');
    expect(dialogDecision('confirm', 'accept')).toBe('accept');
    expect(dialogDecision('prompt', 'auto')).toBe('accept');
    expect(dialogDecision('beforeunload', 'dismiss')).toBe('accept');
  });
});

describe('installDialogHandler', () => {
  test('dismiss policy dismisses and records the dialog', async () => {
    const page = fakePage();
    const state = { dialogPolicy: 'dismiss', lastDialog: null };
    installDialogHandler(page, state);
    const dialog = {
      type: () => 'confirm',
      message: () => 'Continue?',
      defaultPrompt: () => undefined,
      page: () => ({ url: () => 'https://x/login' }),
      dismiss: jest.fn(async () => {}),
      accept: jest.fn(async () => {}),
    };
    await page.emit('dialog', dialog);
    expect(dialog.dismiss).toHaveBeenCalledTimes(1);
    expect(dialog.accept).not.toHaveBeenCalled();
    expect(state.lastDialog).toMatchObject({ type: 'confirm', message: 'Continue?', decision: 'dismiss', handled: true });
  });

  test('accept policy accepts prompts with their default text', async () => {
    const page = fakePage();
    const state = { dialogPolicy: 'accept', lastDialog: null };
    installDialogHandler(page, state);
    const dialog = {
      type: () => 'prompt',
      message: () => 'Name',
      defaultPrompt: () => 'guest',
      page: () => ({ url: () => 'https://x' }),
      dismiss: jest.fn(async () => {}),
      accept: jest.fn(async () => {}),
    };
    await page.emit('dialog', dialog);
    expect(dialog.accept).toHaveBeenCalledWith('guest');
  });

  test('beforeunload is accepted even under dismiss policy', async () => {
    const page = fakePage();
    const state = { dialogPolicy: 'dismiss', lastDialog: null };
    installDialogHandler(page, state);
    const dialog = {
      type: () => 'beforeunload',
      message: () => '',
      defaultPrompt: () => undefined,
      page: () => ({ url: () => 'https://x' }),
      dismiss: jest.fn(async () => {}),
      accept: jest.fn(async () => {}),
    };
    await page.emit('dialog', dialog);
    expect(dialog.accept).toHaveBeenCalled();
    expect(dialog.dismiss).not.toHaveBeenCalled();
  });

  test('is idempotent (only one listener per page)', () => {
    const page = fakePage();
    const state = {};
    installDialogHandler(page, state);
    installDialogHandler(page, state);
    expect(page.on).toHaveBeenCalledTimes(1);
  });
});

describe('summarizeDialog', () => {
  test('is JSON-safe and tolerates missing methods', () => {
    const rec = summarizeDialog({}, 'dismiss');
    expect(rec).toMatchObject({ decision: 'dismiss' });
    expect(rec.type).toBeUndefined();
  });
});

describe('findChallengeWidgets', () => {
  test('wraps page.evaluate and returns its result', async () => {
    const page = fakePage({ evaluate: async () => ({ url: 'u', title: 't', count: 1, challenges: [{ kind: 'slider' }] }) });
    const out = await findChallengeWidgets(page);
    expect(out.count).toBe(1);
    expect(out.challenges[0].kind).toBe('slider');
  });

  test('never throws on a broken page', async () => {
    const page = fakePage({ evaluate: async () => { throw new Error('detached'); } });
    const out = await findChallengeWidgets(page);
    expect(out.count).toBe(0);
    expect(out.error).toMatch(/detached/);
  });

  test('returns an error object when there is no page', async () => {
    expect(await findChallengeWidgets(null)).toMatchObject({ count: 0, error: 'no page' });
  });
});

describe('findPuzzleGap', () => {
  test('wraps page.evaluate and returns gap result', async () => {
    const page = fakePage({ evaluate: async () => ({ ok: true, deltaX: 120, confidence: 0.85 }) });
    const out = await findPuzzleGap(page);
    expect(out.ok).toBe(true);
    expect(out.deltaX).toBe(120);
  });

  test('never throws on broken page', async () => {
    const page = fakePage({ evaluate: async () => { throw new Error('context dead'); } });
    const out = await findPuzzleGap(page);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/context dead/);
  });

  test('returns error on null page', async () => {
    const out = await findPuzzleGap(null);
    expect(out.ok).toBe(false);
    expect(out.error).toBe('no page');
  });
});

describe('findTabState', () => {
  test('finds a tab across session groups', () => {
    const tabState = { page: {} };
    const sessions = new Map([['u1', { tabGroups: new Map([['default', new Map([['t1', tabState]])]]) }]]);
    expect(findTabState(sessions, 'u1', 't1')).toMatchObject({ tabState });
    expect(findTabState(sessions, 'u1', 'missing')).toBeNull();
    expect(findTabState(sessions, 'nope', 't1')).toBeNull();
  });
});

describe('puzzle gap colour spaces and edge fallback', () => {
  test('normalizeColorMode accepts the four documented values', () => {
    for (const mode of COLOR_MODES) expect(normalizeColorMode(mode)).toBe(mode);
    expect(normalizeColorMode('auto')).toBe('auto');
    expect(normalizeColorMode('bogus')).toBe('luma');
    expect(normalizeColorMode('bogus', 'auto')).toBe('auto');
  });

  test('colorDistance: identical pixels are 0 in every space', () => {
    for (const mode of ['luma', 'ycbcr', 'hsv']) {
      expect(colorDistance(12, 200, 90, 12, 200, 90, mode)).toBe(0);
    }
  });

  test('ycbcr/hsv separate colours that share a luminance better than luma', () => {
    // Equal-luma red/blue pair would be invisible to a pure luminance metric.
    const luma = colorDistance(255, 0, 0, 0, 0, 255, 'luma');
    const ycbcr = colorDistance(255, 0, 0, 0, 0, 255, 'ycbcr');
    const hsv = colorDistance(255, 0, 0, 0, 0, 255, 'hsv');
    expect(ycbcr).toBeGreaterThan(luma);
    expect(hsv).toBeGreaterThan(luma);
    expect(hsv).toBeGreaterThan(0.3);
  });

  test('sobelEdgeMap is flat on a uniform image and hot on an edge', () => {
    const width = 6, height = 6;
    const flat = new Uint8ClampedArray(width * height * 4).fill(120);
    expect(Math.max(...sobelEdgeMap(flat, width, height))).toBeCloseTo(0, 5);

    const edged = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const value = x < 3 ? 0 : 255;
        const index = (y * width + x) * 4;
        edged[index] = value; edged[index + 1] = value; edged[index + 2] = value; edged[index + 3] = 255;
      }
    }
    const map = sobelEdgeMap(edged, width, height);
    const maxAtEdge = Math.max(map[2 * width + 2], map[2 * width + 3], map[2 * width + 1]);
    expect(maxAtEdge).toBeGreaterThan(0.5);
  });

  function makePixels(width, height, pixel) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = (y * width + x) * 4;
        const [r, g, b, a] = pixel(x, y);
        data[index] = r; data[index + 1] = g; data[index + 2] = b; data[index + 3] = a ?? 255;
      }
    }
    return data;
  }

  // A textured background with a 16x16 piece cut from (20, 2); the matcher must
  // recover exactly that offset.
  const bgWidth = 48, bgHeight = 24, pieceSize = 16;
  const tone = (x, y) => 25 + ((x * 7 + y * 13) % 180);
  const bgData = makePixels(bgWidth, bgHeight, (x, y) => [tone(x, y), tone(x, y), tone(x, y)]);
  const pieceData = makePixels(pieceSize, pieceSize, (x, y) => [tone(x + 20, y + 2), tone(x + 20, y + 2), tone(x + 20, y + 2)]);
  const matchArgs = {
    bgData, bgWidth, bgHeight,
    pieceData, pieceWidth: pieceSize, pieceHeight: pieceSize,
    minX: 0, maxX: pieceSize - 1, minY: 0, maxY: pieceSize - 1, searchY: 2,
  };

  test('computeGapMatch finds the exact offset in each colour space', () => {
    for (const mode of ['luma', 'ycbcr', 'hsv']) {
      const match = computeGapMatch({ ...matchArgs, mode });
      expect(match.bestX).toBe(20);
      expect(match.quality).toBeGreaterThan(0.5);
      expect(match.samples).toBeGreaterThan(0);
    }
  });

  test('computeGapMatch edge mode also finds the offset (gradient-safe fallback)', () => {
    const match = computeGapMatch({ ...matchArgs, useEdges: true });
    expect(Math.abs(match.bestX - 20)).toBeLessThanOrEqual(2);
    expect(match.quality).toBeGreaterThanOrEqual(0);
  });

  test('findPuzzleGap forwards colorMode and edgeFallback into the page script', async () => {
    const evaluate = jest.fn(async () => ({ ok: true, deltaX: 1, confidence: 1 }));
    await findPuzzleGap(fakePage({ evaluate }), { colorMode: 'hsv', edgeFallback: false });
    const source = evaluate.mock.calls.at(-1)[0];
    expect(source).toContain('REQUESTED_MODE = "hsv"');
    expect(source).toContain('ALLOW_EDGE_FALLBACK = false');
    await findPuzzleGap(fakePage({ evaluate }), { colorMode: 'bogus' });
    expect(evaluate.mock.calls.at(-1)[0]).toContain('REQUESTED_MODE = "luma"');
  });

  test('generated inspectors are syntactically valid after helper injection', async () => {
    const gapEvaluate = jest.fn(async () => ({}));
    await findPuzzleGap(fakePage({ evaluate: gapEvaluate }));
    expect(() => new Function('return ' + gapEvaluate.mock.calls.at(-1)[0])).not.toThrow();

    const challengeEvaluate = jest.fn(async () => ({}));
    await findChallengeWidgets(fakePage({ evaluate: challengeEvaluate }));
    expect(() => new Function('return ' + challengeEvaluate.mock.calls.at(-1)[0])).not.toThrow();
  });
});

async function buildApp() {
  const routes = new Map();
  const app = { post: (path, _middleware, handler) => routes.set(path, handler) };
  const page = fakePage({ evaluate: jest.fn(async () => ({ url: 'https://x', title: 'Login', count: 1, challenges: [{ kind: 'recaptcha' }] })) });
  const tabState = { page };
  const sessions = new Map([['u1', { tabGroups: new Map([['default', new Map([['t1', tabState]])]]) }]]);
  const events = { on: jest.fn(), emit: jest.fn() };
  const ctx = {
    events,
    sessions,
    normalizeUserId: (id) => String(id),
    auth: () => ((_req, _res, next) => next()),
    log: () => {},
    safeError: (e) => String(e?.message || e),
  };
  const { register } = await import('./index.js');
  await register(app, ctx);
  return { routes, page, events };
}

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}

describe('dialog policy scoping by domain', () => {
  test('normalizeHost accepts hosts, URLs, dotted prefixes, and ports', () => {
    expect(normalizeHost('https://Login.Example.com/path?x=1')).toBe('login.example.com');
    expect(normalizeHost('.example.com')).toBe('example.com');
    expect(normalizeHost('example.com:8443')).toBe('example.com');
    expect(normalizeHost('  EXAMPLE.com  ')).toBe('example.com');
    expect(normalizeHost('')).toBe('');
    expect(normalizeHost(null)).toBe('');
  });

  test('validatePolicyDomain enforces host shape and wildcard breadth', () => {
    expect(validatePolicyDomain('example.com')).toMatchObject({ ok: true, key: 'example.com' });
    expect(validatePolicyDomain('https://Login.Example.com/x')).toMatchObject({
      ok: true, host: 'login.example.com', key: 'login.example.com',
    });
    expect(validatePolicyDomain('*.example.com')).toMatchObject({
      ok: true, wildcard: true, key: '*.example.com',
    });
    // A single-label wildcard would auto-accept on a whole TLD.
    expect(validatePolicyDomain('*.com')).toMatchObject({ ok: false });
    expect(validatePolicyDomain('*.localhost')).toMatchObject({ ok: false });
    // Malformed hosts.
    for (const bad of ['', '   ', '-bad.com', 'bad-.com', 'a..b', 'exa mple.com', 'x'.repeat(64) + '.com', null, 42, {}]) {
      expect(validatePolicyDomain(bad).ok).toBe(false);
    }
    // 255-char host exceeds the 253-char limit (four 63-char labels + dots).
    expect(validatePolicyDomain(Array(4).fill('a'.repeat(63)).join('.')).ok).toBe(false);
  });

  test('parsePolicyDomain canonicalizes the stored key', () => {
    expect(parsePolicyDomain('*.Example.COM')).toEqual({ wildcard: true, host: 'example.com', key: '*.example.com' });
    expect(parsePolicyDomain('Example.com.')).toEqual({ wildcard: false, host: 'example.com.', key: 'example.com.' });
  });

  test('matchHostPolicy prefers exact host, then the longest wildcard', () => {
    const policies = { 'example.com': 'accept', '*.example.com': 'dismiss', '*.a.example.com': 'auto' };
    expect(matchHostPolicy(policies, 'example.com')).toBe('accept');
    expect(matchHostPolicy(policies, 'www.example.com')).toBe('dismiss');
    expect(matchHostPolicy(policies, 'x.a.example.com')).toBe('auto');
    expect(matchHostPolicy(policies, 'other.com')).toBeNull();
    expect(matchHostPolicy(null, 'example.com')).toBeNull();
  });

  test('resolveDialogPolicy: a scoped override beats the tab default', () => {
    const state = { dialogPolicy: 'dismiss', dialogPolicyByDomain: { 'login.example.com': 'accept' } };
    expect(resolveDialogPolicy(state, 'https://login.example.com/x')).toBe('accept');
    expect(resolveDialogPolicy(state, 'https://app.example.com/x')).toBe('dismiss');
    expect(resolveDialogPolicy({ dialogPolicy: 'auto' }, 'https://x')).toBe('auto');
  });

  test('installDialogHandler applies the per-domain policy and records host/policy', async () => {
    const page = fakePage();
    const state = { dialogPolicy: 'dismiss', dialogPolicyByDomain: { 'login.example.com': 'accept' }, lastDialog: null };
    installDialogHandler(page, state);
    const dialog = {
      type: () => 'confirm',
      message: () => 'Continue?',
      defaultPrompt: () => undefined,
      page: () => ({ url: () => 'https://login.example.com/step2' }),
      dismiss: jest.fn(async () => {}),
      accept: jest.fn(async () => {}),
    };
    await page.emit('dialog', dialog);
    expect(dialog.accept).toHaveBeenCalledTimes(1);
    expect(dialog.dismiss).not.toHaveBeenCalled();
    expect(state.lastDialog).toMatchObject({ policy: 'accept', host: 'login.example.com', decision: 'accept' });
  });

  test('installDialogHandler falls back to the tab default for other hosts', async () => {
    const page = fakePage();
    const state = { dialogPolicy: 'dismiss', dialogPolicyByDomain: { 'login.example.com': 'accept' }, lastDialog: null };
    installDialogHandler(page, state);
    const dialog = {
      type: () => 'confirm',
      message: () => 'Continue?',
      defaultPrompt: () => undefined,
      page: () => ({ url: () => 'https://shop.example.org/checkout' }),
      dismiss: jest.fn(async () => {}),
      accept: jest.fn(async () => {}),
    };
    await page.emit('dialog', dialog);
    expect(dialog.dismiss).toHaveBeenCalledTimes(1);
    expect(state.lastDialog).toMatchObject({ policy: 'dismiss', host: 'shop.example.org' });
  });

  test('dialog route scopes a policy to one domain without changing the default', async () => {
    const { routes } = await buildApp();
    const res = fakeRes();
    await routes.get('/verification/dialog')({
      body: { userId: 'u1', tabId: 't1', domain: 'login.example.com', policy: 'accept' },
    }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.dialogPolicyByDomain).toEqual({ 'login.example.com': 'accept' });
    expect(res.body.dialogPolicy).toBe('dismiss');
    expect(res.body.effectivePolicy).toBe('dismiss');
  });

  test('dialog route rejects a domain without a policy and clears overrides on request', async () => {
    const { routes } = await buildApp();
    const missing = fakeRes();
    await routes.get('/verification/dialog')({ body: { userId: 'u1', tabId: 't1', domain: 'a.example.com' } }, missing);
    expect(missing.statusCode).toBe(400);
    expect(missing.body.code).toBe('policy_required');

    const handler = routes.get('/verification/dialog');
    const set = fakeRes();
    await handler({ body: { userId: 'u1', tabId: 't1', domain: 'a.example.com', policy: 'accept' } }, set);
    expect(set.body.dialogPolicyByDomain).toEqual({ 'a.example.com': 'accept' });

    const cleared = fakeRes();
    await handler({ body: { userId: 'u1', tabId: 't1', clearDomain: 'A.Example.com' } }, cleared);
    expect(cleared.body.dialogPolicyByDomain).toEqual({});
    expect(cleared.body.domainPolicyCount).toBe(0);

    const clearedAll = fakeRes();
    await handler({ body: { userId: 'u1', tabId: 't1', clearDomains: true } }, clearedAll);
    expect(clearedAll.body.dialogPolicyByDomain).toEqual({});
  });

  test('dialog route rejects over-broad wildcards and caps domain overrides', async () => {
    const { routes } = await buildApp();
    const handler = routes.get('/verification/dialog');

    const broad = fakeRes();
    await handler({ body: { userId: 'u1', tabId: 't1', domain: '*.com', policy: 'accept' } }, broad);
    expect(broad.statusCode).toBe(400);
    expect(broad.body.code).toBe('invalid_domain');

    const first = fakeRes();
    await handler({ body: { userId: 'u1', tabId: 't1', domain: 'login.example.com', policy: 'accept' } }, first);
    expect(first.body.domainPolicyCount).toBe(1);
    expect(first.body.domainPolicyLimit).toBe(MAX_DOMAIN_POLICIES);
    expect(first.body.hostPolicy).toBeNull();
    expect(first.body.dialogPolicyByDomain).toEqual({ 'login.example.com': 'accept' });

    for (let index = 1; index < MAX_DOMAIN_POLICIES; index += 1) {
      const ok = fakeRes();
      await handler({ body: { userId: 'u1', tabId: 't1', domain: `site${index}.example.com`, policy: 'accept' } }, ok);
      expect(ok.statusCode).toBe(200);
    }

    const overflow = fakeRes();
    await handler({ body: { userId: 'u1', tabId: 't1', domain: 'one-too-many.example.com', policy: 'accept' } }, overflow);
    expect(overflow.statusCode).toBe(400);
    expect(overflow.body.code).toBe('too_many_domain_policies');
    expect(overflow.body.limit).toBe(MAX_DOMAIN_POLICIES);

    // Updating an existing key is still allowed at the cap.
    const update = fakeRes();
    await handler({ body: { userId: 'u1', tabId: 't1', domain: 'login.example.com', policy: 'dismiss' } }, update);
    expect(update.statusCode).toBe(200);
    expect(update.body.domainPolicyCount).toBe(MAX_DOMAIN_POLICIES);
  });

  test('dialog response reports the matching host policy', async () => {
    const { routes, page } = await buildApp();
    page.url = () => 'https://login.example.com/step2';
    const res = fakeRes();
    await routes.get('/verification/dialog')({
      body: { userId: 'u1', tabId: 't1', domain: 'login.example.com', policy: 'accept' },
    }, res);
    expect(res.body.host).toBe('login.example.com');
    expect(res.body.effectivePolicy).toBe('accept');
    expect(res.body.hostPolicy).toEqual({ key: 'login.example.com', policy: 'accept' });
  });

  test('puzzle-gap route forwards colorMode/edgeFallback to the inspector', async () => {
    const { routes, page } = await buildApp();
    const res = fakeRes();
    await routes.get('/verification/puzzle-gap')({
      body: { userId: 'u1', tabId: 't1', colorMode: 'ycbcr', edgeFallback: false },
    }, res);
    expect(res.statusCode).toBe(200);
    const source = page.evaluate.mock.calls.at(-1)[0];
    expect(source).toContain('REQUESTED_MODE = "ycbcr"');
    expect(source).toContain('ALLOW_EDGE_FALLBACK = false');
  });
});

describe('login-guard routes', () => {
  test('registers verification routes', async () => {
    const { routes } = await buildApp();
    expect([...routes.keys()].sort()).toEqual(['/verification/challenge', '/verification/dialog', '/verification/puzzle-gap']);
  });

  test('puzzle-gap route handles request', async () => {
    const { routes } = await buildApp();
    const res = fakeRes();
    await routes.get('/verification/puzzle-gap')({ body: { userId: 'u1', tabId: 't1' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.tabId).toBe('t1');
  });

  test('puzzle-gap route 404s unknown tab', async () => {
    const { routes } = await buildApp();
    const res = fakeRes();
    await routes.get('/verification/puzzle-gap')({ body: { userId: 'u1', tabId: 'gone' } }, res);
    expect(res.statusCode).toBe(404);
  });

  test('challenge route returns detected widgets', async () => {
    const { routes } = await buildApp();
    const res = fakeRes();
    await routes.get('/verification/challenge')({ body: { userId: 'u1', tabId: 't1' } }, res);
    expect(res.body.ok).toBe(true);
    expect(res.body.challenges[0].kind).toBe('recaptcha');
    expect(res.body.dialogPolicy).toBe('dismiss');
  });

  test('challenge route 404s unknown tab', async () => {
    const { routes } = await buildApp();
    const res = fakeRes();
    await routes.get('/verification/challenge')({ body: { userId: 'u1', tabId: 'gone' } }, res);
    expect(res.statusCode).toBe(404);
  });

  test('dialog route sets and reports a policy', async () => {
    const { routes } = await buildApp();
    const res = fakeRes();
    await routes.get('/verification/dialog')({ body: { userId: 'u1', tabId: 't1', policy: 'accept' } }, res);
    expect(res.body.dialogPolicy).toBe('accept');
    expect(res.body.supportedPolicies).toEqual(DIALOG_POLICIES);
  });

  test('dialog route rejects an unknown policy', async () => {
    const { routes } = await buildApp();
    const res = fakeRes();
    await routes.get('/verification/dialog')({ body: { userId: 'u1', tabId: 't1', policy: 'nope' } }, res);
    expect(res.statusCode).toBe(400);
  });
});
