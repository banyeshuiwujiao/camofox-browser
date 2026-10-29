const DRAG_BUTTONS = new Set(['left', 'right', 'middle']);
const DRAG_EASINGS = new Set(['linear', 'easeInOut']);
const DRAG_REQUEST_KEYS = new Set([
  'userId', 'start', 'end', 'steps', 'durationMs', 'button',
  // Slider / humanization semantics ported from ego-lite's eased pointer motion.
  'easing', 'jitterPx', 'overshootPx', 'deltaX', 'deltaY', 'handle',
  // Optional rect (viewport coords) that the overshoot peak must stay inside.
  'overshootBounds',
]);
const DRAG_POINT_KEYS = new Set(['x', 'y']);
const DRAG_BOUNDS_KEYS = new Set(['x', 'y', 'width', 'height']);

export const DRAG_DEFAULT_STEPS = 12;
export const DRAG_MIN_STEPS = 1;
export const DRAG_MAX_STEPS = 24;
export const DRAG_DEFAULT_DURATION_MS = 800;
export const DRAG_MIN_DURATION_MS = 1;
export const DRAG_MAX_DURATION_MS = 5_000;
export const DRAG_DEFAULT_EASING = 'linear';
export const DRAG_MAX_JITTER_PX = 8;
export const DRAG_MAX_OVERSHOOT_PX = 24;
export const DRAG_MAX_DELTA = 10_000;
export const DRAG_MAX_BOUNDS = 100_000;
export const DRAG_EASING_MODES = ['linear', 'easeInOut'];
/**
 * An overshooting drag keeps its peak this many CSS px inside the allowed rect.
 *
 * The mouse button is always released on `end` (see `runTrustedDrag`), so an
 * overshoot cannot "click" a neighbour; what it can do is drag the pointer
 * across a neighbouring control mid-flight, firing hover/`mouseenter` side
 * effects (opening a hover menu, triggering trackers). Keeping the peak away
 * from the rect edge (viewport by default, or an explicit `overshootBounds`
 * such as the captcha widget box) makes that collision unlikely.
 */
export const DRAG_SAFE_MARGIN_PX = 4;

function hasOnlyKeys(value, allowedKeys) {
  return Object.keys(value).every(key => allowedKeys.has(key));
}

function validPoint(point) {
  return point && typeof point === 'object' &&
    Number.isFinite(point.x) && Number.isFinite(point.y);
}

function validBounds(bounds) {
  if (!bounds || typeof bounds !== 'object' || !hasOnlyKeys(bounds, DRAG_BOUNDS_KEYS)) return false;
  const x = bounds.x === undefined ? 0 : bounds.x;
  const y = bounds.y === undefined ? 0 : bounds.y;
  return finiteInRange(x, -DRAG_MAX_BOUNDS, DRAG_MAX_BOUNDS) &&
    finiteInRange(y, -DRAG_MAX_BOUNDS, DRAG_MAX_BOUNDS) &&
    finiteInRange(bounds.width, 1, DRAG_MAX_BOUNDS) &&
    finiteInRange(bounds.height, 1, DRAG_MAX_BOUNDS);
}

function invalid(error) {
  return { ok: false, error };
}

function finiteInRange(value, min, max) {
  return Number.isFinite(value) && value >= min && value <= max;
}

/** Smoothstep easing — matches ego-lite's `t*t*(3-2t)` wheel motion curve. */
export function easeInOut(progress) {
  return progress * progress * (3 - 2 * progress);
}

/**
 * Map a linear 0..1 progress through the requested easing curve.
 * `linear` keeps the exact legacy behaviour; `easeInOut` speeds up in the
 * middle and eases at both ends (more human, better for slider challenges).
 */
export function easeDragProgress(progress, easing = DRAG_DEFAULT_EASING) {
  return easing === 'easeInOut' ? easeInOut(progress) : progress;
}

/**
 * Validate and normalize the JSON contract for an atomic trusted drag.
 *
 * The endpoints are flexible so a slider handle can be dragged without the
 * caller first reading coordinates:
 *   - `start` (point) OR `handle` (ref like `e12` / CSS selector) supplies A;
 *   - `end` (point) OR `deltaX`/`deltaY` (relative to A) supplies B.
 *
 * Keeping this pure makes the route's strict input contract testable without
 * importing server.js (which starts the browser server as a side effect).
 */
export function validateTrustedDragRequest(body) {
  const request = body && typeof body === 'object' ? body : {};
  if (!hasOnlyKeys(request, DRAG_REQUEST_KEYS)) {
    return invalid('unknown drag request field');
  }

  const { userId, start, end, handle } = request;

  if (typeof userId !== 'string' || userId.trim() === '') {
    return invalid('userId required');
  }

  const hasStart = start !== undefined;
  const hasHandle = typeof handle === 'string' && handle.trim() !== '';
  if (!hasStart && !hasHandle) {
    return invalid('start coordinates or handle required');
  }
  if (hasStart) {
    if (!validPoint(start) || !hasOnlyKeys(start, DRAG_POINT_KEYS)) {
      return invalid('start must be {x, y} with finite coordinates');
    }
  }
  if (handle !== undefined && typeof handle !== 'string') {
    return invalid('handle must be a ref or selector string');
  }

  const hasDeltaX = request.deltaX !== undefined;
  const hasDeltaY = request.deltaY !== undefined;
  const hasEnd = end !== undefined;
  if (!hasEnd && !hasDeltaX && !hasDeltaY) {
    return invalid('end coordinates or deltaX/deltaY required');
  }
  if (hasEnd && (!validPoint(end) || !hasOnlyKeys(end, DRAG_POINT_KEYS))) {
    return invalid('end must be {x, y} with finite coordinates');
  }
  for (const [name, value] of [['deltaX', request.deltaX], ['deltaY', request.deltaY]]) {
    if (value !== undefined && !finiteInRange(value, -DRAG_MAX_DELTA, DRAG_MAX_DELTA)) {
      return invalid(`${name} must be a finite number between -${DRAG_MAX_DELTA} and ${DRAG_MAX_DELTA}`);
    }
  }
  if (hasEnd && (hasDeltaX || hasDeltaY)) {
    return invalid('provide either end or deltaX/deltaY, not both');
  }

  const steps = request.steps === undefined ? DRAG_DEFAULT_STEPS : request.steps;
  if (!Number.isInteger(steps) || steps < DRAG_MIN_STEPS || steps > DRAG_MAX_STEPS) {
    return invalid(`steps must be an integer between ${DRAG_MIN_STEPS} and ${DRAG_MAX_STEPS}`);
  }

  const durationMs = request.durationMs === undefined ? DRAG_DEFAULT_DURATION_MS : request.durationMs;
  if (!Number.isInteger(durationMs) || durationMs < DRAG_MIN_DURATION_MS || durationMs > DRAG_MAX_DURATION_MS) {
    return invalid(`durationMs must be an integer between ${DRAG_MIN_DURATION_MS} and ${DRAG_MAX_DURATION_MS}`);
  }

  const button = request.button === undefined ? 'left' : request.button;
  if (!DRAG_BUTTONS.has(button)) {
    return invalid('button must be one of: left, right, middle');
  }

  const easing = request.easing === undefined ? DRAG_DEFAULT_EASING : request.easing;
  if (!DRAG_EASINGS.has(easing)) {
    return invalid(`easing must be one of: ${[...DRAG_EASINGS].join(', ')}`);
  }

  const jitterPx = request.jitterPx === undefined ? 0 : request.jitterPx;
  if (!finiteInRange(jitterPx, 0, DRAG_MAX_JITTER_PX)) {
    return invalid(`jitterPx must be a number between 0 and ${DRAG_MAX_JITTER_PX}`);
  }

  const overshootPx = request.overshootPx === undefined ? 0 : request.overshootPx;
  if (!finiteInRange(overshootPx, 0, DRAG_MAX_OVERSHOOT_PX)) {
    return invalid(`overshootPx must be a number between 0 and ${DRAG_MAX_OVERSHOOT_PX}`);
  }

  const overshootBounds = request.overshootBounds;
  if (overshootBounds !== undefined && !validBounds(overshootBounds)) {
    return invalid('overshootBounds must be {x?, y?, width, height} with a positive finite size');
  }

  return {
    ok: true,
    value: {
      userId: userId.trim(),
      ...(hasStart ? { start: { x: start.x, y: start.y } } : {}),
      ...(hasHandle ? { handle: handle.trim() } : {}),
      ...(hasEnd
        ? { end: { x: end.x, y: end.y } }
        : {
            ...(hasDeltaX ? { deltaX: request.deltaX } : {}),
            ...(hasDeltaY ? { deltaY: request.deltaY } : {}),
          }),
      steps,
      durationMs,
      button,
      easing,
      jitterPx,
      overshootPx,
      ...(overshootBounds !== undefined
        ? {
            overshootBounds: {
              x: overshootBounds.x === undefined ? 0 : overshootBounds.x,
              y: overshootBounds.y === undefined ? 0 : overshootBounds.y,
              width: overshootBounds.width,
              height: overshootBounds.height,
            },
          }
        : {}),
    },
  };
}

/**
 * Largest overshoot (px) that keeps the overshoot peak inside `bounds`, with
 * `margin` px of clearance on every edge.
 *
 * `bounds` is a rect in viewport coordinates: `{ x = 0, y = 0, width, height }`.
 * The plain `{ width, height }` form (Playwright `viewportSize()`) still works.
 * Returns `Infinity` when bounds are unknown so callers keep the requested
 * value; returns `0` when the rect is too small to hold any overshoot.
 */
export function maxOvershootWithinBounds({ start, end, bounds, margin = DRAG_SAFE_MARGIN_PX }) {
  if (!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return Infinity;
  const originX = Number.isFinite(bounds.x) ? bounds.x : 0;
  const originY = Number.isFinite(bounds.y) ? bounds.y : 0;
  const lowX = originX + margin;
  const highX = originX + bounds.width - margin;
  const lowY = originY + margin;
  const highY = originY + bounds.height - margin;
  if (highX <= lowX || highY <= lowY) return 0;

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);
  if (!(distance > 0)) return 0;
  const ux = dx / distance;
  const uy = dy / distance;

  let limit = Infinity;
  if (ux > 0) limit = Math.min(limit, (highX - end.x) / ux);
  else if (ux < 0) limit = Math.min(limit, (lowX - end.x) / ux);
  if (uy > 0) limit = Math.min(limit, (highY - end.y) / uy);
  else if (uy < 0) limit = Math.min(limit, (lowY - end.y) / uy);
  return Math.max(0, limit);
}

/**
 * Clamp a requested overshoot to the safe maximum for one rect.
 * `bounds` accepts `{ width, height }` (viewport) or `{ x, y, width, height }`
 * (an explicit control/widget box such as a captcha container).
 */
export function clampOvershoot({ start, end, overshootPx = 0, bounds, margin = DRAG_SAFE_MARGIN_PX }) {
  if (!(overshootPx > 0)) return 0;
  return Math.min(overshootPx, maxOvershootWithinBounds({ start, end, bounds, margin }));
}

/**
 * Build the ordered list of points (excluding the initial press point) a drag
 * visits while the button is held. The first generated point is `start`, the
 * last is exactly `end`.
 *
 * - `easing: 'easeInOut'` applies smoothstep to progress (human-like accel).
 * - `overshootPx` pushes the path slightly along the drag vector mid-flight
 *   and returns to `end` — a small human overshoot.
 * - `jitterPx` adds a deterministic perpendicular wiggle (zero at both ends),
 *   seeded from the endpoints so tests stay reproducible.
 */
export function buildDragPath({ start, end, steps, easing = DRAG_DEFAULT_EASING, jitterPx = 0, overshootPx = 0 }) {
  const path = [];
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);
  const ux = distance > 0 ? dx / distance : 0;
  const uy = distance > 0 ? dy / distance : 0;
  // Perpendicular unit vector for jitter.
  const px = -uy;
  const py = ux;
  // Deterministic phase in [0, 2π) from the endpoints.
  const phase = ((Math.abs(start.x * 0.137 + start.y * 0.731 + end.x * 0.291)) % 1) * Math.PI * 2;

  for (let index = 1; index <= steps; index += 1) {
    const progress = index / steps;
    const eased = easeDragProgress(progress, easing);
    let travel = eased;
    if (overshootPx > 0 && distance > 0) {
      // Remap progress so the gesture reaches `end` early, overshoots by
      // `overshootPx`, then settles back exactly on `end` — a human "dart past
      // the target then correct" motion. When overshootPx is 0 this branch is
      // skipped and the default (linear-of-easing) path is byte-identical.
      const peak = 1 + overshootPx / distance;
      const kneeP = 0.85;
      const baseAtKnee = easeDragProgress(kneeP, easing) || 1e-6;
      travel = progress <= kneeP
        ? peak * (eased / baseAtKnee)
        : peak + (1 - peak) * ((progress - kneeP) / (1 - kneeP));
    }
    let x = start.x + dx * travel;
    let y = start.y + dy * travel;

    if (index < steps && jitterPx > 0) {
      const wobble = jitterPx * Math.sin(progress * Math.PI * 4 + phase) * Math.sin(Math.PI * progress);
      x += px * wobble;
      y += py * wobble;
    }

    // Keep the terminal point pixel-exact.
    if (index === steps) {
      x = end.x;
      y = end.y;
    }
    path.push({ x, y });
  }
  return path;
}

/**
 * Keep the gesture timeout below the tab-lock queue timeout so a concurrent
 * request cannot time out first and tear down the tab while the drag runs.
 */
export function trustedDragTimeoutMs({ steps, durationMs }, handlerTimeoutMs, lockTimeoutMs) {
  const gestureBudgetMs = durationMs + (steps + 3) * 1000;
  return Math.min(lockTimeoutMs - 1000, Math.max(handlerTimeoutMs, gestureBudgetMs));
}

/**
 * Dispatch one trusted, low-level mouse drag through Playwright's mouse API.
 *
 * `sleep` is injectable for deterministic unit tests. In production the
 * default timer spaces the interpolated moves so their cumulative delay is
 * exactly durationMs (subject to the host scheduler's timer resolution).
 *
 * The motion itself is produced by `buildDragPath`, which carries the eased /
 * jittered / overshoot trajectory needed for slider-style challenges while
 * keeping the default (linear, no jitter) byte-for-byte identical to the
 * original implementation.
 */
export async function runTrustedDrag(page, options, sleep) {
  const {
    start, end, steps, durationMs, button,
    easing = DRAG_DEFAULT_EASING,
    jitterPx = 0,
    overshootPx = 0,
    overshootBounds = null,
  } = options;
  const wait = sleep || ((ms) => new Promise(resolve => setTimeout(resolve, ms)));

  // The overshoot peak is `end + unitVector * overshootPx`; clamp it inside the
  // live viewport, and additionally inside an explicit control box when the
  // caller supplies one (e.g. the captcha widget rect from `challenge` /
  // `puzzle_gap`). Callers with a known viewport can pass `bounds` explicitly.
  let bounds = options.bounds || null;
  if (!bounds && page && typeof page.viewportSize === 'function') {
    try {
      const viewport = page.viewportSize();
      if (viewport && Number.isFinite(viewport.width) && Number.isFinite(viewport.height)) {
        bounds = { width: viewport.width, height: viewport.height };
      }
    } catch { /* no viewport information: keep the requested overshoot */ }
  }
  let appliedOvershootPx = clampOvershoot({ start, end, overshootPx, bounds });
  if (overshootBounds) {
    appliedOvershootPx = Math.min(
      appliedOvershootPx,
      clampOvershoot({ start, end, overshootPx, bounds: overshootBounds }),
    );
  }
  const path = buildDragPath({ start, end, steps, easing, jitterPx, overshootPx: appliedOvershootPx });

  await page.mouse.move(start.x, start.y);

  let pressed = false;
  try {
    await page.mouse.down({ button });
    pressed = true;

    let elapsed = 0;
    for (let index = 1; index <= path.length; index += 1) {
      const progress = index / path.length;
      const nextElapsed = Math.round(durationMs * progress);
      const delay = nextElapsed - elapsed;
      if (delay > 0) await wait(delay);
      const point = path[index - 1];
      await page.mouse.move(point.x, point.y);
      elapsed = nextElapsed;
    }

    return {
      ok: true,
      start,
      end,
      steps,
      durationMs,
      button,
      easing,
      jitterPx,
      overshootPx: appliedOvershootPx,
      ...(overshootBounds ? { overshootBounds } : {}),
      // Only present when the viewport/control box forced the overshoot down;
      // keeps the default response shape unchanged for the common case.
      ...(appliedOvershootPx !== overshootPx
        ? { requestedOvershootPx: overshootPx, overshootClamped: true }
        : {}),
    };
  } finally {
    if (pressed) await page.mouse.up({ button });
  }
}
