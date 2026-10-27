import { readFileSync } from 'fs';
import { browserErrorCode, browserErrorRecovery, browserErrorStatus } from '../../lib/browser-errors.js';
import { startServer, stopServer, getServerUrl } from '../helpers/startServer.js';
import { createClient } from '../helpers/client.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('timed-out tab operations', () => {
  let serverUrl;

  beforeAll(async () => {
    await startServer(0, { HANDLER_TIMEOUT_MS: '5000' });
    serverUrl = getServerUrl();
  }, 120000);

  afterAll(async () => {
    await stopServer();
  }, 30000);

  test('marks native mouse calls as bounded tab-destroying operations', () => {
    const source = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
    const clickStart = source.indexOf("app.post('/tabs/:tabId/click'");
    const clickRoute = source.slice(clickStart, source.indexOf("app.post('/tabs/:tabId/upload'", clickStart));

    for (const action of ['move', 'down', 'up']) {
      expect(clickRoute).toContain(`withTimeout(tabState.page.mouse.${action}`);
    }
    expect(clickRoute).toContain("destroyTimedOutTab(session, tabId, 'operation_timeout', userId)");
  });

  test('allows tab creation to finish its one-session recovery', () => {
    const source = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
    const createStart = source.indexOf("app.post('/tabs', async function createTabRoute");
    const createRoute = source.slice(createStart, source.indexOf('// Navigate', createStart));

    expect(source).toContain('function tabCreateRequestTimeoutMs()');
    expect(source).toContain('return Math.max(requestTimeoutMs(), (NEW_PAGE_TIMEOUT_MS * 2) + 5000);');
    // 预算必须由该函数给出；允许换行/缩进差异
    expect(createRoute).toMatch(/\}\)\(\)\s*,\s*tabCreateRequestTimeoutMs\(\)\s*,\s*'tab create'\s*\)/);
    // 超时是可恢复错误（503 + retry 提示），不是裸 500
    expect(createRoute).toContain("code: 'tab_create_timeout'");
    // 会话正在重建时等待后重试一次，而不是直接失败
    expect(source).toContain('async function waitForSessionReady(');
    expect(createRoute).toMatch(/isDeadContextError\(err\)\s*&&\s*!req\._camofoxRetried/);
  });

  test('returns a stable recoverable error after timeout cleanup', () => {
    const error = Object.assign(new Error('action timed out after 5000ms'), { code: 'tab_timeout' });

    expect(browserErrorStatus(error)).toBe(410);
    expect(browserErrorCode(error)).toBe('tab_timeout');
    expect(browserErrorRecovery(error)).toBe('create_new_tab');
  });

  test('destroys a tab before releasing queued evaluate work after an evaluate timeout', async () => {
    const client = createClient(serverUrl);
    const { tabId } = await client.createTab();

    try {
      const first = client.evaluate(tabId, 'new Promise(() => {})').catch(error => error);
      await wait(50);
      const queued = client.evaluate(tabId, '42').catch(error => error);
      const [firstError, queuedError] = await Promise.all([first, queued]);

      expect(firstError.status).toBe(410);
      expect(firstError.data.code).toBe('tab_timeout');
      expect(firstError.data.recovery).toBe('create_new_tab');
      expect(queuedError.status).toBe(410);
      expect(queuedError.data.code).toBe('tab_destroyed');
    } finally {
      await client.cleanup();
    }
  }, 30000);
});
