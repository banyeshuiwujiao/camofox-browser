/**
 * Unit tests for tab-URL identity (`lib/url-match.js`).
 *
 * Reuse is a correctness feature: matching two different pages means the agent
 * silently operates on the wrong tab, so the "what is the same target" rules
 * are pinned here.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { normalizeTabUrl, sameTabUrl } from '../../lib/url-match.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(join(__dirname, '../../server.js'), 'utf8');

describe('normalizeTabUrl', () => {
  test('keeps the path, query string, and fragment', () => {
    expect(normalizeTabUrl('https://example.com/a/b?x=1&y=2#top')).toBe('https://example.com/a/b?x=1&y=2#top');
  });

  test('normalizes incidental differences only', () => {
    const canonical = 'https://example.com/a?x=1';
    expect(normalizeTabUrl('https://example.com/a/?x=1')).toBe(canonical);
    expect(normalizeTabUrl('https://example.com//a?x=1')).toBe(canonical);
    expect(normalizeTabUrl('  https://EXAMPLE.com/a?x=1  ')).toBe(canonical);
    expect(normalizeTabUrl('https://example.com:443/a?x=1')).toBe(canonical);
  });

  test('a bare fragment or query marker is dropped', () => {
    expect(normalizeTabUrl('https://e.com/a?')).toBe('https://e.com/a');
    expect(normalizeTabUrl('https://e.com/a#')).toBe('https://e.com/a');
  });

  test('keeps the root path distinct from a deep path', () => {
    expect(normalizeTabUrl('https://e.com')).toBe('https://e.com/');
    expect(normalizeTabUrl('https://e.com/')).toBe('https://e.com/');
    expect(normalizeTabUrl('https://e.com/x')).toBe('https://e.com/x');
  });

  test('rejects non-http(s) and unparsable input', () => {
    for (const value of ['about:blank', 'data:text/html,hi', 'chrome-error://chromewebdata/', '', '   ', null, undefined, 42, 'not a url']) {
      expect(normalizeTabUrl(value)).toBeNull();
    }
  });
});

describe('sameTabUrl', () => {
  test('query string differences never match', () => {
    expect(sameTabUrl('https://e.com/a?x=1', 'https://e.com/a?x=2')).toBe(false);
    expect(sameTabUrl('https://e.com/a?x=1', 'https://e.com/a?x=1&y=2')).toBe(false);
    // Query order is significant and documented as such.
    expect(sameTabUrl('https://e.com/a?x=1&y=2', 'https://e.com/a?y=2&x=1')).toBe(false);
  });

  test('fragment differences never match', () => {
    expect(sameTabUrl('https://e.com/a#top', 'https://e.com/a#bottom')).toBe(false);
    expect(sameTabUrl('https://e.com/a', 'https://e.com/a#top')).toBe(false);
  });

  test('path differences never match', () => {
    expect(sameTabUrl('https://e.com/a', 'https://e.com/b')).toBe(false);
    expect(sameTabUrl('https://e.com/a', 'https://sub.e.com/a')).toBe(false);
    expect(sameTabUrl('http://e.com/a', 'https://e.com/a')).toBe(false);
  });

  test('identical targets match despite incidental differences', () => {
    expect(sameTabUrl('https://e.com/a?x=1#h', 'https://E.com/a/?x=1#h')).toBe(true);
    expect(sameTabUrl('https://e.com/a', 'https://e.com/a')).toBe(true);
  });

  test('a live about:blank / error page never reuses', () => {
    expect(sameTabUrl('about:blank', 'about:blank')).toBe(false);
    expect(sameTabUrl('chrome-error://chromewebdata/', 'chrome-error://chromewebdata/')).toBe(false);
    expect(sameTabUrl('about:blank', 'https://e.com/')).toBe(false);
  });
});

describe('/tabs reuse wiring', () => {
  test('reuse is opt-in and matched through sameTabUrl', () => {
    expect(serverSrc).toContain('req.body.reuseTab === true');
    expect(serverSrc).toContain('sameTabUrl(safePageUrl(state.page), url)');
    expect(serverSrc).not.toContain('req.body.reuseTab !== false');
  });
});