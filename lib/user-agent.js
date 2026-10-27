/**
 * User-Agent override support.
 *
 * Camoufox always reports a Firefox UA, which is exactly what its anti-detect
 * fingerprint is built around -- but a growing number of sites hard-block
 * Firefox. Polyv's vod-player is one: its `forbidClients` gate rejects
 * Firefox >= 68 and renders "#024 此视频不支持在本浏览器上播放" before any
 * media is fetched.
 *
 * The override is applied as a Playwright BrowserContext option, which rewrites
 * both the HTTP `User-Agent` header and the `navigator.userAgent` seen by page
 * scripts. It therefore has to be decided when the session's context is
 * created: Camoufox deliberately runs automation scripts in an isolated world
 * (its `main_world_eval` default), so `addInitScript` cannot patch page globals
 * after the fact.
 *
 * This is a compatibility shim, not browser emulation: the engine is still
 * Firefox and the rest of the fingerprint is unchanged.
 *
 * Known trap (2026-10, measured): mobile UAs must NOT be used here. If the UA
 * contains "Mobile", 华医网 switches to the Polyv **mobile** player, which
 * re-injects `maxPlaybackRateLimit` in the page's main-world script (that cannot
 * be preempted by a context option) and authenticates with a different flow that
 * returns `#007` under a desktop Firefox engine. Always use a desktop UA
 * template for this workaround.
 */

/** Longest user agent we accept; real ones are ~120-200 chars. */
export const MAX_USER_AGENT_LENGTH = 512;

/** Chrome major version used by the `chrome` shorthand. */
export const CHROME_UA_MAJOR = 142;

const CHROME_UA_TEMPLATES = {
  win32: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_UA_MAJOR}.0.0.0 Safari/537.36`,
  darwin: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_UA_MAJOR}.0.0.0 Safari/537.36`,
  linux: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_UA_MAJOR}.0.0.0 Safari/537.36`,
};

/** Build the `chrome` shorthand UA for a Node platform string. */
export function chromeUserAgent(platform = process.platform) {
  return CHROME_UA_TEMPLATES[platform] || CHROME_UA_TEMPLATES.win32;
}

/**
 * Validate a literal user agent string.
 * @returns {string|null} an error message, or null when the value is usable.
 */
export function validateUserAgent(value) {
  if (typeof value !== 'string') return 'userAgent must be a string';
  const ua = value.trim();
  if (!ua) return 'userAgent must not be empty';
  if (ua.length > MAX_USER_AGENT_LENGTH) {
    return `userAgent must be at most ${MAX_USER_AGENT_LENGTH} characters`;
  }
  // Printable ASCII only: the value ends up in an HTTP header, so CR/LF and
  // other control characters must be rejected (header injection).
  if (!/^[\x20-\x7e]+$/.test(ua)) {
    return 'userAgent must contain printable ASCII characters only';
  }
  return null;
}

/**
 * Resolve a caller-supplied user agent.
 *
 * Accepts:
 *   - a literal UA string (returned trimmed)
 *   - "chrome" / "chrome-latest" -> a Chrome UA for the host platform
 *   - null / undefined / "" -> null (no override)
 *
 * @throws {Error} with statusCode 400 for invalid input.
 */
export function resolveUserAgent(value, { platform = process.platform } = {}) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw Object.assign(new Error('userAgent must be a string'), { statusCode: 400 });
  }
  const raw = value.trim();
  if (!raw) return null;
  const shorthand = raw.toLowerCase();
  if (shorthand === 'chrome' || shorthand === 'chrome-latest') {
    return chromeUserAgent(platform);
  }
  const error = validateUserAgent(raw);
  if (error) throw Object.assign(new Error(error), { statusCode: 400 });
  return raw;
}

/**
 * Count the tabs currently registered in a session.
 * @param {{ tabGroups?: Map<string, Map<string, unknown>> }} session
 */
export function countSessionTabs(session) {
  if (!session || !(session.tabGroups instanceof Map)) return 0;
  let total = 0;
  for (const group of session.tabGroups.values()) total += group.size;
  return total;
}

/** A "browser family" key: use it to compare two UAs by engine family, not version. */
export function userAgentFamily(userAgent) {
  if (!userAgent) return 'firefox';
  return /chrome\//i.test(userAgent) ? 'chrome' : 'firefox';
}

/**
 * The checkout-friendly version of countSessionTabs, used to close a session's
 * leftover tabs before re-creating it with a different user agent.
 * Keep the semantics in one place so the two callers cannot drift.
 */
export function userAgentMismatchMessage(userId, tabCount) {
  return (
    `Session already exists with a different user agent and has ${tabCount} open tab(s). ` +
    `Delete the session first (DELETE /sessions/${userId}) and create the tab again with the requested userAgent.`
  );
}