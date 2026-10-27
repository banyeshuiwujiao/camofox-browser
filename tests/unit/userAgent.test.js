import { describe, expect, test } from '@jest/globals';
import {
  MAX_USER_AGENT_LENGTH,
  CHROME_UA_MAJOR,
  chromeUserAgent,
  countSessionTabs,
  resolveUserAgent,
  userAgentFamily,
  userAgentMismatchMessage,
  validateUserAgent,
} from '../../lib/user-agent.js';

describe('chromeUserAgent', () => {
  test('returns a platform-appropriate Chrome UA', () => {
    expect(chromeUserAgent('win32')).toContain('Windows NT 10.0; Win64; x64');
    expect(chromeUserAgent('darwin')).toContain('Macintosh; Intel Mac OS X');
    expect(chromeUserAgent('linux')).toContain('X11; Linux x86_64');
    for (const platform of ['win32', 'darwin', 'linux', 'aix']) {
      const ua = chromeUserAgent(platform);
      expect(ua).toContain(`Chrome/${CHROME_UA_MAJOR}.0.0.0`);
      expect(ua).toContain('Safari/537.36');
      expect(validateUserAgent(ua)).toBeNull();
    }
  });

  test('falls back to the Windows UA for unknown platforms', () => {
    expect(chromeUserAgent('aix')).toBe(chromeUserAgent('win32'));
  });
});

describe('resolveUserAgent', () => {
  test('returns null when no override is requested', () => {
    expect(resolveUserAgent(undefined)).toBeNull();
    expect(resolveUserAgent(null)).toBeNull();
    expect(resolveUserAgent('')).toBeNull();
    expect(resolveUserAgent('   ')).toBeNull();
  });

  test('expands the chrome shorthand for the host platform', () => {
    expect(resolveUserAgent('chrome', { platform: 'darwin' })).toBe(chromeUserAgent('darwin'));
    expect(resolveUserAgent('Chrome-Latest', { platform: 'linux' })).toBe(chromeUserAgent('linux'));
  });

  test('passes literal user agents through, trimmed', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    expect(resolveUserAgent(`  ${ua}  `)).toBe(ua);
  });

  test('rejects non-string, oversized, and control-character values', () => {
    expect(() => resolveUserAgent(42)).toThrow(/must be a string/);
    expect(() => resolveUserAgent('x'.repeat(MAX_USER_AGENT_LENGTH + 1))).toThrow(/at most/);
    expect(() => resolveUserAgent('Mozilla/5.0\r\nX-Injected: 1')).toThrow(/printable ASCII/);
    try {
      resolveUserAgent('Mozilla/5.0\r\nX-Injected: 1');
    } catch (err) {
      expect(err.statusCode).toBe(400);
    }
  });
});

describe('countSessionTabs', () => {
  test('counts tabs across every tab group', () => {
    const session = {
      tabGroups: new Map([
        ['default', new Map([['a', {}], ['b', {}]])],
        ['other', new Map([['c', {}]])],
      ]),
    };
    expect(countSessionTabs(session)).toBe(3);
  });

  test('returns 0 for empty or malformed sessions', () => {
    expect(countSessionTabs({ tabGroups: new Map() })).toBe(0);
    expect(countSessionTabs({ tabGroups: new Map([['g', new Map()]]) })).toBe(0);
    expect(countSessionTabs(null)).toBe(0);
    expect(countSessionTabs({})).toBe(0);
  });
});

describe('userAgentFamily', () => {
  test('treats empty/unspecified as the default Firefox family', () => {
    expect(userAgentFamily('')).toBe('firefox');
    expect(userAgentFamily(null)).toBe('firefox');
    expect(userAgentFamily('Mozilla/5.0 (Windows NT 10.0; rv:152.0) Gecko/20100101 Firefox/152.0')).toBe('firefox');
  });

  test('detects Chrome-family UAs (so a version-only difference is not a mismatch)', () => {
    expect(userAgentFamily('Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36')).toBe('chrome');
    expect(userAgentFamily('Mozilla/5.0 Chrome/142.0.0.0 Safari/537.36')).toBe('chrome');
    expect(userAgentFamily(chromeUserAgent())).toBe('chrome');
  });
});

describe('userAgentMismatchMessage', () => {
  test('explains the tab count and how to recover', () => {
    const msg = userAgentMismatchMessage('dsh', 2);
    expect(msg).toContain('2 open tab');
    expect(msg).toContain('DELETE /sessions/dsh');
    expect(msg).toContain('userAgent');
  });
});