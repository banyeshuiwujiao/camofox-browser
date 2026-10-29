/**
 * Login-verification semantics ported from ego-lite.
 *
 * Two reusable pieces, both engine-agnostic (they take a Playwright `page`):
 *
 *  1. `findChallengeWidgets(page)` — inspect the live DOM for common
 *     "verify you are human" widgets (reCAPTCHA / hCaptcha / Turnstile /
 *     Geetest / Aliyun / Tencent / generic slider). For slider widgets it also
 *     reports the draggable handle box and a suggested horizontal drag delta,
 *     so callers can immediately feed it to the trusted-drag endpoint.
 *
 *  2. `installDialogHandler(page, state)` — model native `alert/confirm/prompt/
 *     beforeunload` dialogs as an observable page result instead of letting
 *     Playwright silently dismiss them. A per-tab policy decides the action
 *     (`dismiss` default = today's Playwright behaviour, `accept`, `auto`),
 *     and the last dialog is recorded on `state.lastDialog`.
 *
 * `beforeunload` is always accepted so navigation can proceed (matching
 * ego-lite's documented requirement), regardless of the configured policy.
 */

// Ordered from most specific to most generic. A page can match several; the
// caller usually only needs the first (nearest / most specific) one.
export const CHALLENGE_SIGNATURES = [
  { kind: 'recaptcha', selectors: ['iframe[src*="recaptcha"]', '.g-recaptcha', '#g-recaptcha', '[data-sitekey][class*="recaptcha"]'] },
  { kind: 'hcaptcha', selectors: ['iframe[src*="hcaptcha"]', '.h-captcha', '#h-captcha', '[data-hcaptcha-widget-id]'] },
  { kind: 'turnstile', selectors: ['iframe[src*="challenges.cloudflare.com"]', '.cf-turnstile', '#cf-turnstile'] },
  { kind: 'geetest', selectors: ['.geetest_holder', '.geetest_panel', '[class*="geetest"]'] },
  { kind: 'aliyun-nc', selectors: ['#nc_1_wrapper', '#nc_1_n1z', '.nc-container', '[id^="nc_"]'] },
  { kind: 'tencent', selectors: ['#tcaptcha_iframe', '#TencentCaptcha', '[id*="tcaptcha"]'] },
  { kind: 'slider', selectors: ['[class*="slide-verify"]', '[class*="slider-verify"]', '[class*="verify-slider"]', '[class*="captcha-slider"]', '[class*="drag-verify"]'] },
];

// Potential draggable knobs inside a slider container.
export const SLIDER_HANDLE_SELECTORS = [
  '#nc_1_n1z',
  '.geetest_slider_button',
  '[class*="slider"] [class*="btn"]',
  '[class*="slider"] [class*="handle"]',
  '[class*="slide"] [class*="knob"]',
  '[class*="drag"] [class*="handle"]',
  '[class*="captcha"] [class*="button"]',
];

// Potential tracks/rails a knob slides along.
export const SLIDER_TRACK_SELECTORS = [
  '#nc_1_n1t',
  '.geetest_slider',
  '[class*="slider"][class*="track"]',
  '[class*="slider"][class*="rail"]',
  '[class*="slide"][class*="track"]',
];

export const DIALOG_POLICIES = ['dismiss', 'accept', 'auto'];

/**
 * Hard limits for per-domain dialog overrides.
 *
 * The map is client-writable through `POST /verification/dialog`, and every
 * `/verification/challenge` / `/verification/dialog` response echoes it back.
 * Without limits a caller could grow a tab's map with near-100KB keys (the
 * global JSON body limit) and balloon those responses. The wildcard rule is a
 * security rule as much as a size rule: `*.com` would auto-accept dialogs on
 * every .com site the tab later visits, which defeats the point of scoping.
 */
export const MAX_DOMAIN_POLICIES = 32;
export const MAX_HOST_LENGTH = 253;
export const MAX_HOST_LABEL_LENGTH = 63;

// DNS-ish label: letters/digits, optional interior hyphens.
const HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function isValidHostName(host) {
  if (typeof host !== 'string' || host.length === 0 || host.length > MAX_HOST_LENGTH) return false;
  return host.split('.').every(label =>
    label.length > 0 && label.length <= MAX_HOST_LABEL_LENGTH && HOST_LABEL_PATTERN.test(label));
}

export function normalizeDialogPolicy(policy, fallback = 'dismiss') {
  return DIALOG_POLICIES.includes(policy) ? policy : fallback;
}

/**
 * Normalize a host or URL to the key used in `dialogPolicyByDomain`.
 * Accepts `example.com`, `https://Example.com/login`, `.example.com` and
 * `example.com:8080`; returns a lower-case host without scheme, path or port.
 */
export function normalizeHost(value) {
  if (value === undefined || value === null) return '';
  let host = String(value).trim().toLowerCase();
  if (!host) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) {
    try { host = new URL(host).host; } catch { return ''; }
  }
  host = host.replace(/^\/+/, '').replace(/\/.*$/, '').replace(/^\.+/, '').replace(/:\d+$/, '');
  return host;
}

/**
 * Split a caller-supplied domain key into its canonical parts.
 * `*.example.com` → `{ wildcard: true, host: 'example.com', key: '*.example.com' }`.
 */
export function parsePolicyDomain(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const wildcard = raw.startsWith('*.');
  const host = normalizeHost(wildcard ? raw.slice(2) : raw);
  return { wildcard, host, key: wildcard ? `*.${host}` : host };
}

/**
 * Validate a domain key before it is stored in `dialogPolicyByDomain`.
 *
 * Rejects over-long / malformed hosts and over-broad wildcards: a wildcard must
 * cover at least two labels, so `*.example.com` is allowed but `*.com` is not.
 */
export function validatePolicyDomain(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, error: 'domain must be a host name like "example.com"' };
  }
  const { wildcard, host, key } = parsePolicyDomain(value);
  if (!host || !isValidHostName(host)) {
    return {
      ok: false,
      error: `domain must be a valid host name (max ${MAX_HOST_LENGTH} chars, labels 1-${MAX_HOST_LABEL_LENGTH}, letters/digits/hyphens)`,
    };
  }
  if (wildcard && host.split('.').length < 2) {
    return { ok: false, error: 'wildcard must cover at least two labels, e.g. "*.example.com" (not "*.com")' };
  }
  return { ok: true, host, key, wildcard };
}

/**
 * Resolve the matching policy *key* for `host` from a `{ host: policy }` map.
 *
 * Matching order: exact host, then the longest `*.suffix` wildcard entry
 * (which also covers the bare suffix: `*.example.com` matches `example.com`
 * and every subdomain). Returns `null` when nothing matches.
 */
export function matchHostPolicyKey(policies, host) {
  if (!policies || typeof policies !== 'object') return null;
  const name = normalizeHost(host);
  if (!name) return null;
  if (DIALOG_POLICIES.includes(policies[name])) return name;
  const labels = name.split('.');
  for (let index = 1; index < labels.length; index += 1) {
    const wildcard = `*.${labels.slice(index).join('.')}`;
    if (DIALOG_POLICIES.includes(policies[wildcard])) return wildcard;
  }
  return null;
}

/** Resolve a policy value for `host`, or `null` when nothing matches. */
export function matchHostPolicy(policies, host) {
  const key = matchHostPolicyKey(policies, host);
  return key ? policies[key] : null;
}

/**
 * Effective dialog policy for a page: the per-domain override wins over the
 * tab-wide default. This is what makes `accept` scoped to the one login domain
 * instead of auto-accepting every confirm on every site the agent visits.
 */
export function resolveDialogPolicy(state, host) {
  const scoped = matchHostPolicy(state?.dialogPolicyByDomain, host);
  if (scoped) return scoped;
  return normalizeDialogPolicy(state?.dialogPolicy);
}

/**
 * Decide how to action a dialog for a given policy. `beforeunload` is always
 * accepted so the page may navigate away (login redirects, SPA route changes).
 */
export function dialogDecision(type, policy = 'dismiss') {
  if (type === 'beforeunload') return 'accept';
  if (policy === 'accept' || policy === 'auto') return 'accept';
  return 'dismiss';
}

/** Compact, JSON-safe snapshot of a Playwright Dialog. */
export function summarizeDialog(dialog, decision, extra = {}) {
  return {
    type: typeof dialog?.type === 'function' ? dialog.type() : undefined,
    message: typeof dialog?.message === 'function' ? dialog.message() : undefined,
    defaultPrompt: typeof dialog?.defaultPrompt === 'function' ? dialog.defaultPrompt() : undefined,
    url: safeDialogUrl(dialog),
    decision,
    ...extra,
  };
}

function safeDialogUrl(dialog) {
  try {
    const page = typeof dialog?.page === 'function' ? dialog.page() : null;
    return page && typeof page.url === 'function' ? page.url() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Attach a `dialog` listener to a Playwright page once. Records the last
 * dialog on `state.lastDialog` and applies the effective policy: the
 * per-domain override for the dialog's page host (`state.dialogPolicyByDomain`)
 * if one matches, otherwise the tab-wide `state.dialogPolicy`.
 * Returns a dispose function that removes the listener.
 */
export function installDialogHandler(page, state, hooks = {}) {
  if (!page || typeof page.on !== 'function') return () => {};
  if (state.__dialogHandlerInstalled) return () => {};
  state.__dialogHandlerInstalled = true;
  state.dialogPolicy = normalizeDialogPolicy(state.dialogPolicy);
  if (!state.dialogPolicyByDomain || typeof state.dialogPolicyByDomain !== 'object') {
    state.dialogPolicyByDomain = Object.create(null);
  }
  if (state.lastDialog === undefined) state.lastDialog = null;

  const onDialog = async (dialog) => {
    let type = 'unknown';
    try { type = dialog.type(); } catch { /* noop */ }
    const host = normalizeHost(safeDialogUrl(dialog));
    const policy = resolveDialogPolicy(state, host);
    const decision = dialogDecision(type, policy);
    const record = summarizeDialog(dialog, decision, { policy, host: host || undefined });
    try {
      if (decision === 'accept') {
        await dialog.accept(record.defaultPrompt === undefined ? undefined : record.defaultPrompt);
      } else {
        await dialog.dismiss();
      }
      record.handled = true;
    } catch (err) {
      record.handled = false;
      record.error = String(err?.message || err);
    }
    record.at = Date.now();
    state.lastDialog = record;
    try { hooks.onDialog?.(record); } catch { /* subscriber errors must not break the page */ }
  };

  page.on('dialog', onDialog);
  return () => {
    try { page.off?.('dialog', onDialog); } catch { /* noop */ }
    state.__dialogHandlerInstalled = false;
  };
}

/** Build the in-page inspection script (an IIFE returning JSON). */
function challengeInspectorSource() {
  const signatures = JSON.stringify(CHALLENGE_SIGNATURES.map(s => ({ kind: s.kind, selectors: s.selectors })));
  const handleSelectors = JSON.stringify(SLIDER_HANDLE_SELECTORS);
  const trackSelectors = JSON.stringify(SLIDER_TRACK_SELECTORS);
  return `(() => {
    const SIGNATURES = ${signatures};
    const HANDLE_SELECTORS = ${handleSelectors};
    const TRACK_SELECTORS = ${trackSelectors};
    const visibleBox = (el) => {
      if (!el || !el.getBoundingClientRect) return null;
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth || 0, vh = window.innerHeight || 0;
      if (r.width <= 2 || r.height <= 2) return null;
      const left = Math.max(0, r.left), top = Math.max(0, r.top);
      const right = Math.min(vw, r.right), bottom = Math.min(vh, r.bottom);
      if (right <= left || bottom <= top) return null;
      return { x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) };
    };
    const firstVisible = (selectors) => {
      for (const sel of selectors) {
        let nodes = [];
        try { nodes = Array.from(document.querySelectorAll(sel)); } catch (e) { continue; }
        for (const el of nodes) {
          const box = visibleBox(el);
          if (box) return { el, box, selector: sel };
        }
      }
      return null;
    };
    const centre = (box) => ({ x: box.x + Math.round(box.width / 2), y: box.y + Math.round(box.height / 2) });
    const challenges = [];
    const seen = new Set();
    for (const sig of SIGNATURES) {
      const hit = firstVisible(sig.selectors);
      if (!hit) continue;
      // Deduplicate nested widgets (e.g. aliyun container + its own knob).
      const key = hit.box.x + ':' + hit.box.y + ':' + hit.box.width + ':' + hit.box.height;
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = {
        kind: sig.kind,
        selector: hit.selector,
        box: hit.box,
        center: centre(hit.box),
      };
      // Slider details: hand the caller a ready-to-drag handle + delta.
      const handle = firstVisible(HANDLE_SELECTORS);
      const track = firstVisible(TRACK_SELECTORS);
      if (handle) {
        entry.handle = { selector: handle.selector, box: handle.box, center: centre(handle.box) };
        const trackWidth = track ? track.box.width : hit.box.width;
        const travel = Math.max(0, trackWidth - handle.box.width);
        entry.suggestedDrag = {
          start: centre(handle.box),
          deltaX: travel,
          deltaY: 0,
          easing: 'easeInOut',
          jitterPx: 2,
          overshootPx: 6,
          durationMs: 850,
          note: 'feed start+deltaX to the trusted-drag endpoint (action=drag)',
        };
      }
      challenges.push(entry);
    }
    return {
      url: location.href,
      title: document.title,
      count: challenges.length,
      challenges,
    };
  })()`;
}

/** Colour spaces the gap matcher can compare in. `auto` tries all three and
 * keeps the most separable match (useful when a captcha mixes flat and
 * colourful/gradient backgrounds). */
export const COLOR_MODES = ['luma', 'ycbcr', 'hsv'];
export const COLOR_MODE_OPTIONS = ['auto', ...COLOR_MODES];

export function normalizeColorMode(mode, fallback = 'luma') {
  return COLOR_MODE_OPTIONS.includes(mode) ? mode : fallback;
}

/**
 * Perceptual colour distance between two RGB pixels, normalized to 0..1.
 *
 * - `luma` — Rec. 601 luminance difference. Cheapest, and still the best mode
 *   for greyscale captchas.
 * - `ycbcr` — luminance + chroma. Separates a coloured piece from a background
 *   with the same brightness.
 * - `hsv` — hue/saturation/value with a circular hue metric. Handles gradients
 *   and saturated backgrounds where RGB luma is nearly flat.
 *
 * Exported (and injected into the page script via `toString()`) so the unit
 * tests exercise the exact code that runs in the browser.
 */
export function colorDistance(r1, g1, b1, r2, g2, b2, mode = 'luma') {
  if (mode === 'hsv') {
    const toHsv = (r, g, b) => {
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const delta = max - min;
      let hue = 0;
      if (delta > 0) {
        if (max === r) hue = ((g - b) / delta) % 6;
        else if (max === g) hue = (b - r) / delta + 2;
        else hue = (r - g) / delta + 4;
        hue *= 60;
        if (hue < 0) hue += 360;
      }
      return [hue, max === 0 ? 0 : delta / max, max / 255];
    };
    const a = toHsv(r1, g1, b1);
    const c = toHsv(r2, g2, b2);
    let dh = Math.abs(a[0] - c[0]);
    if (dh > 180) dh = 360 - dh;
    const ds = a[1] - c[1];
    const dv = a[2] - c[2];
    const distance = Math.sqrt((dh / 180) * (dh / 180) + ds * ds * 0.8 + dv * dv * 0.5) / 1.45;
    return Math.min(1, distance);
  }
  if (mode === 'ycbcr') {
    const y1 = (0.299 * r1 + 0.587 * g1 + 0.114 * b1) / 255;
    const y2 = (0.299 * r2 + 0.587 * g2 + 0.114 * b2) / 255;
    const cb1 = (128 - 0.168736 * r1 - 0.331264 * g1 + 0.5 * b1) / 255;
    const cb2 = (128 - 0.168736 * r2 - 0.331264 * g2 + 0.5 * b2) / 255;
    const cr1 = (128 + 0.5 * r1 - 0.418688 * g1 - 0.081312 * b1) / 255;
    const cr2 = (128 + 0.5 * r2 - 0.418688 * g2 - 0.081312 * b2) / 255;
    const dy = y1 - y2;
    const dcb = cb1 - cb2;
    const dcr = cr1 - cr2;
    return Math.min(1, Math.sqrt(dy * dy + dcb * dcb * 0.7 + dcr * dcr * 0.5) / 1.48);
  }
  const l1 = (0.299 * r1 + 0.587 * g1 + 0.114 * b1) / 255;
  const l2 = (0.299 * r2 + 0.587 * g2 + 0.114 * b2) / 255;
  return Math.abs(l1 - l2);
}

/**
 * Sobel gradient magnitude map, normalized to 0..1.
 *
 * Edge matching survives the cases where colour matching cannot: the notch
 * outline is still an edge even when the gap is painted in a colour that
 * happens to match the background luminance.
 */
export function sobelEdgeMap(data, width, height) {
  const map = new Float32Array(Math.max(0, width * height));
  if (!data || width < 3 || height < 3) return map;
  const lum = (x, y) => {
    const index = (y * width + x) * 4;
    return (0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2]) / 255;
  };
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const tl = lum(x - 1, y - 1);
      const tc = lum(x, y - 1);
      const tr = lum(x + 1, y - 1);
      const ml = lum(x - 1, y);
      const mr = lum(x + 1, y);
      const bl = lum(x - 1, y + 1);
      const bc = lum(x, y + 1);
      const br = lum(x + 1, y + 1);
      const gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
      const gy = (bl + 2 * bc + br) - (tl + 2 * tc + tr);
      const magnitude = Math.sqrt(gx * gx + gy * gy) / 5.6568;
      map[y * width + x] = magnitude > 1 ? 1 : magnitude;
    }
  }
  return map;
}

/**
 * Slide the piece image over the background and score every candidate offset.
 * Returns the best column plus a separability `quality`:
 *
 *   quality = (secondBest - best) / best, clamped to 0..1
 *
 * `quality` is what callers compare across colour modes and edge matching,
 * because it is scale-free (each mode has its own distance units).
 *
 * `bgData` / `pieceData` are RGBA `Uint8ClampedArray`s; `minX..maxY` are the
 * opaque bounds of the piece; `searchY` is the background row the piece's top
 * edge is expected at.
 */
export function computeGapMatch({
  bgData, bgWidth, bgHeight,
  pieceData, pieceWidth, pieceHeight,
  minX, maxX, minY, maxY, searchY,
  mode = 'luma',
  useEdges = false,
}) {
  const pieceSpanX = Math.max(1, maxX - minX);
  const startScanX = Math.max(1, Math.round(minX + pieceSpanX * 0.8));
  const lastScanX = Math.min(Math.round(bgWidth - pieceSpanX * 0.5), bgWidth - 1);
  const bgEdge = useEdges ? sobelEdgeMap(bgData, bgWidth, bgHeight) : null;
  const pieceEdge = useEdges ? sobelEdgeMap(pieceData, pieceWidth, pieceHeight) : null;

  const pixelDistance = (px, py, bx, by) => {
    if (bx < 0 || bx >= bgWidth || by < 0 || by >= bgHeight) return -1;
    if (useEdges) {
      return Math.abs(pieceEdge[py * pieceWidth + px] - bgEdge[by * bgWidth + bx]);
    }
    const pieceIndex = (py * pieceWidth + px) * 4;
    if (pieceData[pieceIndex + 3] < 60) return -1;
    const bgIndex = (by * bgWidth + bx) * 4;
    return colorDistance(
      pieceData[pieceIndex], pieceData[pieceIndex + 1], pieceData[pieceIndex + 2],
      bgData[bgIndex], bgData[bgIndex + 1], bgData[bgIndex + 2],
      mode,
    );
  };

  const columns = [];
  for (let x = startScanX; x < lastScanX; x += 1) {
    let total = 0;
    let used = 0;
    for (let py = minY; py <= maxY; py += 2) {
      const by = searchY + (py - minY);
      for (let px = minX; px <= maxX; px += 2) {
        const distance = pixelDistance(px, py, x + px - minX, by);
        if (distance < 0) continue;
        total += distance;
        used += 1;
      }
    }
    if (used >= 20) columns.push({ x, score: total / used });
  }
  if (columns.length === 0) {
    return { bestX: startScanX, bestScore: 1, secondScore: 1, quality: 0, samples: 0 };
  }
  columns.sort((a, b) => a.score - b.score);
  const best = columns[0];
  const rival = columns.find(column => Math.abs(column.x - best.x) > 8);
  const secondScore = rival ? rival.score : best.score;
  const quality = best.score <= 0
    ? 1
    : Math.max(0, Math.min(1, (secondScore - best.score) / best.score));
  return { bestX: best.x, bestScore: best.score, secondScore, quality, samples: columns.length };
}

/** Build the in-page puzzle gap inspector script. */
function puzzleGapInspectorSource(options = {}) {
  const customBg = options.bgSelector ? JSON.stringify(options.bgSelector) : 'null';
  const customPiece = options.pieceSelector ? JSON.stringify(options.pieceSelector) : 'null';
  const customHandle = options.handleSelector ? JSON.stringify(options.handleSelector) : 'null';
  const mode = normalizeColorMode(options.colorMode, 'luma');
  // Edge matching runs automatically when colour matching is ambiguous; it can
  // be disabled for pages where the extra pass costs more than it helps.
  const edgeFallback = options.edgeFallback !== false;

  return `(() => {
    // Injected from lib/verification.js: the Node-side unit tests run this
    // exact code, so the matching maths cannot drift between test and page.
    const colorDistance = ${colorDistance.toString()};
    const sobelEdgeMap = ${sobelEdgeMap.toString()};
    const computeGapMatch = ${computeGapMatch.toString()};

    const REQUESTED_MODE = ${JSON.stringify(mode)};
    const ALLOW_EDGE_FALLBACK = ${edgeFallback ? 'true' : 'false'};
    const COLOR_MODES = REQUESTED_MODE === 'auto' ? ['luma', 'ycbcr', 'hsv'] : [REQUESTED_MODE];

    const BG_SELECTORS = [
      ${customBg},
      'canvas.geetest_canvas_bg',
      'canvas.geetest_canvas_fullbg',
      '[class*="verify-img-panel"] canvas',
      '[class*="verify-img-panel"] img',
      '[class*="bg-img"]',
      '[class*="canvas-bg"]',
      '[class*="captcha-img"] canvas',
      '[class*="captcha-img"] img',
      '[class*="slide-verify"] canvas:first-of-type',
      '[class*="slider"] canvas:first-of-type',
      '#slideBg',
      '#cpc_img',
      'canvas'
    ].filter(Boolean);

    const PIECE_SELECTORS = [
      ${customPiece},
      'canvas.geetest_canvas_slice',
      '[class*="verify-sub-block"] canvas',
      '[class*="verify-sub-block"] img',
      '[class*="slice"]',
      '[class*="block"] canvas',
      '[class*="block"] img',
      '[class*="slide-verify"] canvas:last-of-type',
      '[class*="slider"] canvas:last-of-type',
      '#slideBlock',
      '[class*="puzzle-piece"]'
    ].filter(Boolean);

    const HANDLE_SELECTORS = [
      ${customHandle},
      '.geetest_slider_button',
      '[class*="slider"] [class*="btn"]',
      '[class*="slider"] [class*="handle"]',
      '[class*="slide"] [class*="knob"]',
      '[class*="drag"] [class*="handle"]',
      '[class*="verify-move-block"]',
      '[class*="handler"]'
    ].filter(Boolean);

    const visibleBox = (el) => {
      if (!el || !el.getBoundingClientRect) return null;
      const r = el.getBoundingClientRect();
      if (r.width <= 2 || r.height <= 2) return null;
      return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
    };

    const findFirst = (selectors, excludeEl = null) => {
      for (const sel of selectors) {
        let list = [];
        try { list = Array.from(document.querySelectorAll(sel)); } catch (e) { continue; }
        for (const el of list) {
          if (el === excludeEl) continue;
          const box = visibleBox(el);
          if (box) return { el, box, selector: sel };
        }
      }
      return null;
    };

    const bgHit = findFirst(BG_SELECTORS);
    const pieceHit = findFirst(PIECE_SELECTORS, bgHit ? bgHit.el : null);
    const handleHit = findFirst(HANDLE_SELECTORS);

    if (!bgHit) {
      return { ok: false, error: '未找到背景图片或画布元素' };
    }

    const getPixels = (el, box) => {
      const c = document.createElement('canvas');
      const w = el.naturalWidth || el.width || box.width || 300;
      const h = el.naturalHeight || el.height || box.height || 150;
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      if (el.tagName === 'CANVAS') {
        ctx.drawImage(el, 0, 0);
      } else if (el.tagName === 'IMG') {
        ctx.drawImage(el, 0, 0, w, h);
      } else {
        return null;
      }
      try {
        const id = ctx.getImageData(0, 0, w, h);
        return { data: id.data, width: w, height: h, cssWidth: box.width, cssHeight: box.height };
      } catch (e) {
        return null;
      }
    };

    const bgPixels = getPixels(bgHit.el, bgHit.box);
    const piecePixels = pieceHit ? getPixels(pieceHit.el, pieceHit.box) : null;

    if (!bgPixels) {
      return {
        ok: false,
        error: '提取背景图像像素受阻（CORS 或跨域限制）；请使用视觉大模型或截图分析',
        bgBox: bgHit.box,
        pieceBox: pieceHit ? pieceHit.box : null,
        handleBox: handleHit ? handleHit.box : null
      };
    }

    let deltaX = 0;
    let confidence = 0.5;
    let colorModeUsed = REQUESTED_MODE === 'auto' ? 'luma' : REQUESTED_MODE;
    let method = 'color';
    let quality = 0;
    const scale = bgPixels.cssWidth / bgPixels.width;

    if (piecePixels) {
      // Opaque bounds of the piece.
      let minX = piecePixels.width, maxX = 0, minY = piecePixels.height, maxY = 0;
      const pData = piecePixels.data;
      const pW = piecePixels.width, pH = piecePixels.height;
      for (let y = 0; y < pH; y++) {
        for (let x = 0; x < pW; x++) {
          const idx = (y * pW + x) * 4;
          if (pData[idx + 3] > 60) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }

      const pieceWidth = Math.max(10, maxX - minX);
      const pieceHeight = Math.max(10, maxY - minY);

      let searchY = minY;
      if (pieceHit && bgHit && pieceHit.box.y >= bgHit.box.y) {
        searchY = Math.round((pieceHit.box.y - bgHit.box.y) / scale);
      }
      searchY = Math.max(0, Math.min(bgPixels.height - pieceHeight - 1, searchY));

      const matchArgs = {
        bgData: bgPixels.data,
        bgWidth: bgPixels.width,
        bgHeight: bgPixels.height,
        pieceData: pData,
        pieceWidth: pW,
        pieceHeight: pH,
        minX, maxX, minY, maxY, searchY,
      };

      let chosen = null;
      for (const colorMode of COLOR_MODES) {
        const match = computeGapMatch({ ...matchArgs, mode: colorMode, useEdges: false });
        if (!chosen || match.quality > chosen.quality) {
          chosen = { ...match, colorMode, method: 'color' };
        }
      }
      // Colour matching is flat on gradient / low-contrast backgrounds; retry
      // with Sobel edge magnitudes and keep the more separable result.
      if (ALLOW_EDGE_FALLBACK && chosen && (chosen.quality < 0.35 || chosen.bestScore > 0.06)) {
        const edge = computeGapMatch({ ...matchArgs, useEdges: true });
        if (edge.quality > chosen.quality + 0.05) {
          chosen = { ...edge, colorMode: 'edge', method: 'edge' };
        }
      }

      if (chosen) {
        deltaX = Math.round((chosen.bestX - minX) * scale);
        quality = chosen.quality || 0;
        colorModeUsed = chosen.colorMode;
        method = chosen.method;
        confidence = Math.max(0.35, Math.min(0.95, 0.5 + quality * 0.45));
      }
    } else {
      const bgData = bgPixels.data;
      const bgW = bgPixels.width, bgH = bgPixels.height;
      if (ALLOW_EDGE_FALLBACK) {
        // No piece image: the gap is a vertical seam, so the strongest column
        // of Sobel energy is a better cue than raw darkness (which fails on
        // bright or gradient backgrounds).
        const magnitude = sobelEdgeMap(bgData, bgW, bgH);
        const columnEnergy = new Float32Array(bgW);
        for (let x = 1; x < bgW - 1; x++) {
          let total = 0;
          for (let y = 1; y < bgH - 1; y += 2) total += magnitude[y * bgW + x];
          columnEnergy[x] = total;
        }
        let energyX = 50;
        let maxEnergy = -1;
        for (let x = 50; x < bgW - 50; x++) {
          if (columnEnergy[x] > maxEnergy) {
            maxEnergy = columnEnergy[x];
            energyX = x;
          }
        }
        deltaX = Math.round(energyX * scale);
        method = 'column-edge';
        confidence = 0.65;
      } else {
        const columnDarkness = new Float32Array(bgW);
        for (let x = 40; x < bgW - 40; x++) {
          let colSum = 0;
          for (let y = 20; y < bgH - 20; y += 2) {
            const idx = (y * bgW + x) * 4;
            const lum = bgData[idx] * 0.299 + bgData[idx + 1] * 0.587 + bgData[idx + 2] * 0.114;
            colSum += (255 - lum);
          }
          columnDarkness[x] = colSum;
        }
        let darkX = 50;
        let maxVal = -1;
        for (let x = 50; x < bgW - 50; x++) {
          if (columnDarkness[x] > maxVal) {
            maxVal = columnDarkness[x];
            darkX = x;
          }
        }
        deltaX = Math.round(darkX * scale);
        method = 'column-darkness';
        confidence = 0.55;
      }
    }

    const centre = (b) => ({ x: b.x + Math.round(b.width / 2), y: b.y + Math.round(b.height / 2) });
    const startPoint = handleHit ? centre(handleHit.box) : (pieceHit ? centre(pieceHit.box) : { x: bgHit.box.x + 20, y: bgHit.box.y + bgHit.box.height - 20 });

    return {
      ok: true,
      deltaX: Math.max(10, deltaX),
      confidence,
      requestedColorMode: REQUESTED_MODE,
      colorMode: colorModeUsed,
      method,
      quality: Math.round(quality * 100) / 100,
      bgBox: bgHit.box,
      pieceBox: pieceHit ? pieceHit.box : null,
      handleBox: handleHit ? handleHit.box : null,
      suggestedDrag: {
        handle: handleHit ? handleHit.selector : (pieceHit ? pieceHit.selector : null),
        start: startPoint,
        deltaX: Math.max(10, deltaX),
        deltaY: 0,
        easing: 'easeInOut',
        jitterPx: 2,
        overshootPx: 6,
        durationMs: 850
      }
    };
  })()`;
}

/**
 * Inspect a Playwright page for verification/challenge widgets.
 * Never throws for a closed/racing page; returns an `error` field instead.
 */
export async function findChallengeWidgets(page) {
  if (!page || typeof page.evaluate !== 'function') {
    return { url: '', title: '', count: 0, challenges: [], error: 'no page' };
  }
  try {
    const result = await page.evaluate(challengeInspectorSource());
    if (!result || typeof result !== 'object') {
      return { url: '', title: '', count: 0, challenges: [], error: 'empty inspection result' };
    }
    return result;
  } catch (err) {
    return { url: '', title: '', count: 0, challenges: [], error: String(err?.message || err) };
  }
}

/**
 * Inspect page for slider puzzle notch / gap offset between background and piece.
 */
export async function findPuzzleGap(page, options = {}) {
  if (!page || typeof page.evaluate !== 'function') {
    return { ok: false, error: 'no page' };
  }
  try {
    const result = await page.evaluate(puzzleGapInspectorSource(options));
    if (!result || typeof result !== 'object') {
      return { ok: false, error: 'empty puzzle gap result' };
    }
    return result;
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/**
 * Locate a live tabState for (userId, tabId) from the server's sessions map.
 * `sessions` is `Map<userId, { tabGroups: Map<sessionKey, Map<tabId, TabState>> }>`.
 */
export function findTabState(sessions, normalizedUserId, tabId) {
  const session = sessions?.get?.(normalizedUserId);
  if (!session || !session.tabGroups) return null;
  for (const group of session.tabGroups.values()) {
    if (group && group.has(tabId)) {
      return { session, tabState: group.get(tabId) };
    }
  }
  return null;
}
