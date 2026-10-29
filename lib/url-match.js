/**
 * Tab-URL identity used by `POST /tabs` tab reuse.
 *
 * Reuse must not be fooled by incidental differences (trailing slash, duplicate
 * slashes, default port, host casing) while still treating the parts users
 * think of as "a different page" as different:
 *
 *   - the query string is significant (and order-sensitive),
 *   - the fragment is significant (`#section` is a different tab target),
 *   - the path is significant.
 *
 * `http://example.com/a?x=1` and `http://example.com/a?x=2` therefore never
 * reuse each other, and neither do `.../a` and `.../a#top`. Non-HTTP(S) URLs
 * (about:blank, data:, chrome-error:) are never reused: their "identity" is not
 * meaningful and reusing a blank/error tab would hide a real navigation.
 */

const HTTP_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Reduce a URL to the identity used for tab reuse, or `null` when it cannot be
 * parsed / is not an http(s) URL.
 *
 * Normalizations applied (all of them behaviour-preserving for the server):
 *   - host is lower-cased and default ports dropped (the URL parser does this),
 *   - empty path becomes `/`,
 *   - duplicate slashes in the path collapse to one,
 *   - a single trailing slash on a non-root path is dropped,
 *   - bare `?` / `#` suffixes are dropped.
 */
export function normalizeTabUrl(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (!HTTP_PROTOCOLS.has(parsed.protocol)) return null;

  let pathname = parsed.pathname || '/';
  pathname = pathname.replace(/\/{2,}/g, '/');
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);

  const search = parsed.search === '?' ? '' : parsed.search;
  const hash = parsed.hash === '#' ? '' : parsed.hash;
  return `${parsed.protocol}//${parsed.host}${pathname}${search}${hash}`;
}

/**
 * True when two URLs address the same tab target under the rules above.
 * Both sides are normalized, so callers can pass a raw request URL and a live
 * `page.url()` in either order.
 */
export function sameTabUrl(a, b) {
  const normalizedA = normalizeTabUrl(a);
  if (!normalizedA) return false;
  return normalizedA === normalizeTabUrl(b);
}