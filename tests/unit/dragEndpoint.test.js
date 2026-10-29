/**
 * Focused tests for POST /tabs/:tabId/drag.
 *
 * The route is embedded in server.js, so the pure request contract and mouse
 * gesture helper are exercised directly while source assertions protect the
 * route's load-bearing wiring (locks, counters, activity, and freshness).
 */
import { describe, test, expect, jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  DRAG_DEFAULT_DURATION_MS,
  DRAG_DEFAULT_EASING,
  DRAG_DEFAULT_STEPS,
  DRAG_MAX_DURATION_MS,
  DRAG_MAX_JITTER_PX,
  DRAG_MAX_OVERSHOOT_PX,
  DRAG_MAX_STEPS,
  DRAG_SAFE_MARGIN_PX,
  buildDragPath,
  clampOvershoot,
  easeDragProgress,
  maxOvershootWithinBounds,
  runTrustedDrag,
  trustedDragTimeoutMs,
  validateTrustedDragRequest,
} from '../../lib/trusted-drag.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(join(__dirname, '../../server.js'), 'utf8');

const validRequest = () => ({
  userId: 'agent1',
  start: { x: 10, y: 20 },
  end: { x: 110, y: 220 },
});

describe('trusted drag request validation', () => {
  test('requires a non-empty string userId', () => {
    expect(validateTrustedDragRequest({ ...validRequest(), userId: '' })).toMatchObject({ ok: false });
    expect(validateTrustedDragRequest({ ...validRequest(), userId: '   ' })).toMatchObject({ ok: false });
    expect(validateTrustedDragRequest({ ...validRequest(), userId: 123 })).toMatchObject({ ok: false });
  });

  test('requires finite numeric start and end coordinates', () => {
    for (const request of [
      { ...validRequest(), start: undefined },
      { ...validRequest(), end: undefined },
      { ...validRequest(), start: { x: '10', y: 20 } },
      { ...validRequest(), end: { x: 110, y: Infinity } },
      { ...validRequest(), start: { x: NaN, y: 20 } },
      { ...validRequest(), end: { x: 110, y: null } },
    ]) {
      expect(validateTrustedDragRequest(request)).toMatchObject({ ok: false });
    }
  });

  test('applies safe defaults', () => {
    expect(validateTrustedDragRequest(validRequest())).toEqual({
      ok: true,
      value: {
        ...validRequest(),
        steps: DRAG_DEFAULT_STEPS,
        durationMs: DRAG_DEFAULT_DURATION_MS,
        button: 'left',
        easing: DRAG_DEFAULT_EASING,
        jitterPx: 0,
        overshootPx: 0,
      },
    });
  });

  test('accepts bounded integer steps and duration overrides', () => {
    const result = validateTrustedDragRequest({
      ...validRequest(),
      steps: 1,
      durationMs: DRAG_MAX_DURATION_MS,
      button: 'middle',
    });
    expect(result).toEqual({
      ok: true,
      value: {
        ...validRequest(),
        steps: 1,
        durationMs: DRAG_MAX_DURATION_MS,
        button: 'middle',
        easing: DRAG_DEFAULT_EASING,
        jitterPx: 0,
        overshootPx: 0,
      },
    });
    expect(validateTrustedDragRequest({ ...validRequest(), steps: DRAG_MAX_STEPS, durationMs: 1, button: 'right' }).ok).toBe(true);
  });

  test('accepts a slider handle + relative delta instead of start/end', () => {
    const result = validateTrustedDragRequest({
      userId: 'agent1',
      handle: 'e12',
      deltaX: 266,
      easing: 'easeInOut',
      jitterPx: DRAG_MAX_JITTER_PX,
      overshootPx: DRAG_MAX_OVERSHOOT_PX,
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        userId: 'agent1',
        handle: 'e12',
        deltaX: 266,
        easing: 'easeInOut',
        jitterPx: DRAG_MAX_JITTER_PX,
        overshootPx: DRAG_MAX_OVERSHOOT_PX,
      },
    });
  });

  test('requires a press point and a release point', () => {
    expect(validateTrustedDragRequest({ userId: 'a', deltaX: 10 })).toMatchObject({ ok: false });
    expect(validateTrustedDragRequest({ userId: 'a', handle: 'e1' })).toMatchObject({ ok: false });
  });

  test('rejects conflicting end + delta and out-of-range humanization', () => {
    expect(validateTrustedDragRequest({ ...validRequest(), deltaX: 5 })).toMatchObject({ ok: false });
    expect(validateTrustedDragRequest({ ...validRequest(), easing: 'bounce' })).toMatchObject({ ok: false });
    expect(validateTrustedDragRequest({ ...validRequest(), jitterPx: DRAG_MAX_JITTER_PX + 1 })).toMatchObject({ ok: false });
    expect(validateTrustedDragRequest({ ...validRequest(), overshootPx: -1 })).toMatchObject({ ok: false });
  });

  test('accepts and normalizes an overshootBounds rect', () => {
    const explicit = validateTrustedDragRequest({
      ...validRequest(),
      overshootBounds: { x: 320, y: 480, width: 300, height: 40 },
    });
    expect(explicit).toMatchObject({
      ok: true,
      value: { overshootBounds: { x: 320, y: 480, width: 300, height: 40 } },
    });

    const originDefaulted = validateTrustedDragRequest({
      ...validRequest(),
      overshootBounds: { width: 300, height: 40 },
    });
    expect(originDefaulted.value.overshootBounds).toEqual({ x: 0, y: 0, width: 300, height: 40 });
  });

  test('rejects malformed overshootBounds', () => {
    for (const overshootBounds of [
      null,
      'rect',
      {},
      { width: 0, height: 10 },
      { width: 10 },
      { width: 10, height: 10, z: 1 },
      { width: '10', height: 10 },
      { width: 10, height: 10, x: null },
    ]) {
      expect(validateTrustedDragRequest({ ...validRequest(), overshootBounds })).toMatchObject({ ok: false });
    }
  });

  test('rejects invalid step, duration, and button values', () => {
    for (const request of [
      { ...validRequest(), steps: 0 },
      { ...validRequest(), steps: DRAG_MAX_STEPS + 1 },
      { ...validRequest(), steps: 1.5 },
      { ...validRequest(), durationMs: 0 },
      { ...validRequest(), durationMs: DRAG_MAX_DURATION_MS + 1 },
      { ...validRequest(), durationMs: 1.5 },
      { ...validRequest(), button: 'back' },
    ]) {
      expect(validateTrustedDragRequest(request)).toMatchObject({ ok: false });
    }
  });

  test('rejects unknown top-level and coordinate properties', () => {
    expect(validateTrustedDragRequest({ ...validRequest(), extra: true })).toMatchObject({ ok: false });
    expect(validateTrustedDragRequest({
      ...validRequest(),
      start: { ...validRequest().start, z: 1 },
    })).toMatchObject({ ok: false });
    expect(validateTrustedDragRequest({
      ...validRequest(),
      end: { ...validRequest().end, label: 'target' },
    })).toMatchObject({ ok: false });
  });

  test('keeps the drag timeout below the tab-lock queue timeout', () => {
    const maxDrag = { steps: DRAG_MAX_STEPS, durationMs: DRAG_MAX_DURATION_MS };
    expect(trustedDragTimeoutMs(maxDrag, 30000, 35000)).toBe(32000);
    expect(trustedDragTimeoutMs(maxDrag, 60000, 35000)).toBe(34000);
    expect(trustedDragTimeoutMs({ steps: 1, durationMs: 1 }, 30000, 35000)).toBe(30000);
  });
});

describe('trusted drag helper', () => {
  function makePage({ moveImpl } = {}) {
    const events = [];
    const page = {
      mouse: {
        move: jest.fn(async (x, y) => {
          events.push(['move', x, y]);
          return moveImpl?.(x, y);
        }),
        down: jest.fn(async (button) => events.push(['down', button])),
        up: jest.fn(async (button) => events.push(['up', button])),
      },
    };
    return { page, events };
  }

  test('moves to start, presses the requested button, interpolates to exact end, and uses deterministic total delay', async () => {
    const { page, events } = makePage();
    const sleep = jest.fn(async () => {});

    const result = await runTrustedDrag(page, {
      start: { x: 10, y: 20 },
      end: { x: 110, y: 220 },
      steps: 3,
      durationMs: 100,
      button: 'right',
    }, sleep);

    expect(events[0]).toEqual(['move', 10, 20]);
    expect(events[1]).toEqual(['down', { button: 'right' }]);
    expect(events.slice(2, 5)).toHaveLength(3);
    expect(events[2][0]).toBe('move');
    expect(events[2][1]).toBeCloseTo(43.33333333333333);
    expect(events[2][2]).toBeCloseTo(86.66666666666667);
    expect(events[3][1]).toBeCloseTo(76.66666666666666);
    expect(events[3][2]).toBeCloseTo(153.33333333333331);
    expect(events[4]).toEqual(['move', 110, 220]);
    expect(events[5]).toEqual(['up', { button: 'right' }]);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([33, 34, 33]);
    expect(sleep.mock.calls.reduce((total, [ms]) => total + ms, 0)).toBe(100);
    expect(result).toMatchObject({ ok: true, start: { x: 10, y: 20 }, end: { x: 110, y: 220 }, steps: 3, durationMs: 100, button: 'right' });
  });

  test('releases the mouse in finally when an interpolated move fails', async () => {
    const { page, events } = makePage({
      moveImpl: (_x, y) => {
        if (y > 20) throw new Error('move failed');
      },
    });

    await expect(runTrustedDrag(page, {
      start: { x: 10, y: 20 },
      end: { x: 110, y: 220 },
      steps: 2,
      durationMs: 20,
      button: 'middle',
    }, async () => {})).rejects.toThrow('move failed');
    expect(events.at(-1)).toEqual(['up', { button: 'middle' }]);
  });

  test('clamps a requested overshoot to the live viewport and reports the clamp', async () => {
    const { page, events } = makePage();
    page.viewportSize = () => ({ width: 160, height: 100 });
    const result = await runTrustedDrag(page, {
      start: { x: 50, y: 50 },
      end: { x: 155, y: 50 },
      steps: 8,
      durationMs: 40,
      overshootPx: 24,
    }, async () => {});

    expect(result.overshootPx).toBeLessThan(24);
    expect(result.overshootPx).toBeGreaterThan(0);
    expect(result.overshootClamped).toBe(true);
    expect(result.requestedOvershootPx).toBe(24);
    const maxX = Math.max(...events.filter(([kind]) => kind === 'move').map(([, x]) => x));
    expect(maxX).toBeLessThanOrEqual(160 - DRAG_SAFE_MARGIN_PX + 1e-6);
  });

  test('keeps the requested overshoot when the page cannot report its viewport', async () => {
    const { page } = makePage();
    page.viewportSize = () => null;
    const result = await runTrustedDrag(page, {
      start: { x: 50, y: 50 },
      end: { x: 155, y: 50 },
      steps: 4,
      durationMs: 20,
      overshootPx: 24,
    }, async () => {});
    expect(result.overshootPx).toBe(24);
    expect(result.overshootClamped).toBeUndefined();
  });

  test('clamps the overshoot to an explicit widget rect and echoes it', async () => {
    const { page, events } = makePage();
    page.viewportSize = () => ({ width: 800, height: 600 });
    const overshootBounds = { x: 100, y: 40, width: 40, height: 20 };
    const result = await runTrustedDrag(page, {
      start: { x: 50, y: 50 },
      end: { x: 130, y: 50 },
      steps: 6,
      durationMs: 30,
      overshootPx: 24,
      overshootBounds,
    }, async () => {});

    // Rect right edge (140) minus the 4px margin, minus end.x (130) = 6px.
    expect(result.overshootPx).toBeCloseTo(6);
    expect(result.overshootClamped).toBe(true);
    expect(result.overshootBounds).toEqual(overshootBounds);
    const maxX = Math.max(...events.filter(([kind]) => kind === 'move').map(([, x]) => x));
    expect(maxX).toBeLessThanOrEqual(136 + 1e-6);
  });
});

describe('overshoot safety clamp', () => {
  test('maxOvershootWithinBounds stops at the nearest viewport edge', () => {
    // Dragging right: only the 4px margin beyond the end is available.
    expect(maxOvershootWithinBounds({
      start: { x: 150, y: 50 },
      end: { x: 155, y: 50 },
      bounds: { width: 160, height: 100 },
    })).toBeCloseTo(160 - DRAG_SAFE_MARGIN_PX - 155);
    // Dragging up: the free space is end.y - margin.
    expect(maxOvershootWithinBounds({
      start: { x: 50, y: 40 },
      end: { x: 50, y: 20 },
      bounds: { width: 100, height: 100 },
    })).toBeCloseTo(20 - DRAG_SAFE_MARGIN_PX);
    // Unknown viewport keeps the requested value.
    expect(maxOvershootWithinBounds({ start: { x: 0, y: 0 }, end: { x: 10, y: 0 } })).toBe(Infinity);
  });

  test('clampOvershoot keeps a request that fits and shrinks one at the edge', () => {
    const base = { start: { x: 10, y: 50 }, end: { x: 100, y: 50 }, overshootPx: 24 };
    expect(clampOvershoot({ ...base, bounds: { width: 400, height: 200 } })).toBe(24);
    expect(clampOvershoot({ ...base, bounds: { width: 110, height: 200 } }))
      .toBeCloseTo(110 - DRAG_SAFE_MARGIN_PX - 100);
    expect(clampOvershoot({ ...base, overshootPx: 0, bounds: { width: 400, height: 200 } })).toBe(0);
  });

  test('clampOvershoot honors an explicit rect (control-level clamp)', () => {
    const rect = { x: 100, y: 40, width: 40, height: 20 };
    // end sits 6px from the rect's margin-adjusted right edge.
    expect(clampOvershoot({
      start: { x: 50, y: 50 }, end: { x: 130, y: 50 }, overshootPx: 24, bounds: rect,
    })).toBeCloseTo(136 - 130);
    // end already past the rect → no overshoot room.
    expect(clampOvershoot({
      start: { x: 50, y: 50 }, end: { x: 150, y: 50 }, overshootPx: 24, bounds: rect,
    })).toBe(0);
    // rect narrower than the 2*margin → no overshoot room.
    expect(clampOvershoot({
      start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, overshootPx: 10,
      bounds: { x: 0, y: 0, width: 4, height: 4 },
    })).toBe(0);
  });
});

describe('humanized drag path', () => {
  test('easeDragProgress: linear identity, easeInOut smoothstep', () => {
    expect(easeDragProgress(0.25, 'linear')).toBeCloseTo(0.25);
    expect(easeDragProgress(0.5, 'easeInOut')).toBeCloseTo(0.5);
    expect(easeDragProgress(0.25, 'easeInOut')).toBeCloseTo(0.15625);
  });

  test('buildDragPath has `steps` points and is exact at both ends', () => {
    const path = buildDragPath({ start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, steps: 4, easing: 'easeInOut' });
    expect(path).toHaveLength(4);
    expect(path.at(-1)).toEqual({ x: 100, y: 0 });
    expect(path[0].x).toBeCloseTo(100 * easeDragProgress(0.25, 'easeInOut'));
  });

  test('jitter is zero at the endpoint and bounded in between', () => {
    const path = buildDragPath({ start: { x: 0, y: 0 }, end: { x: 200, y: 0 }, steps: 6, easing: 'linear', jitterPx: 4 });
    expect(path.at(-1)).toEqual({ x: 200, y: 0 });
    for (const p of path) expect(Math.abs(p.y)).toBeLessThanOrEqual(4.0000001);
    expect(path.slice(0, -1).some((p) => Math.abs(p.y) > 0)).toBe(true);
  });

  test('overshoot travels past the end mid-flight but returns exactly to end', () => {
    const path = buildDragPath({ start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, steps: 5, easing: 'linear', overshootPx: 10 });
    expect(path.at(-1)).toEqual({ x: 100, y: 0 });
    expect(Math.max(...path.slice(0, -1).map((p) => p.x))).toBeGreaterThan(100);
  });
});

describe('/drag source contract', () => {
  test('registers the atomic drag route and imports the focused helper', () => {
    expect(serverSrc).toMatch(/import \{[^}]*runTrustedDrag[^}]*\} from ['"]\.\/lib\/trusted-drag\.js['"]/s);
    expect(serverSrc).toMatch(/app\.post\(\s*['"]\/tabs\/:tabId\/drag['"]/);
  });

  test('uses user activity, counters, both locks, and freshness invalidation', () => {
    const start = serverSrc.indexOf("app.post('/tabs/:tabId/drag'");
    const end = serverSrc.indexOf('\n// ', start + 1);
    const block = serverSrc.slice(start, end === -1 ? undefined : end);
    expect(block).toMatch(/session\.lastAccess\s*=\s*Date\.now\(\)/);
    expect(block).toMatch(/tabState\.toolCalls\+\+/);
    expect(block).toMatch(/withUserLimit\(/);
    expect(block).toMatch(/withTabLock\(/);
    expect(block).toMatch(/tabState\.lastSnapshot\s*=\s*null/);
    expect(block).toMatch(/tabState\.refs\s*=\s*new Map\(\)/);
    expect(block).toMatch(/req\.body\.userId\s*=\s*userId/);
    expect(block).toMatch(/trustedDragTimeoutMs\([\s\S]*TAB_LOCK_TIMEOUT_MS/);
    expect(block).toMatch(/withTabLock\(tabId,[\s\S]*dragTimeoutMs\)/);
    expect(block).toMatch(/finally/);
  });

  test('performs a low-level mouse gesture rather than DOM dispatch', () => {
    const start = serverSrc.indexOf("app.post('/tabs/:tabId/drag'");
    const end = serverSrc.indexOf('\n// ', start + 1);
    const block = serverSrc.slice(start, end === -1 ? undefined : end);
    expect(block).toMatch(/runTrustedDrag\(tabState\.page/);
    expect(block).toMatch(/res\.json\(result\)/);
  });
});
