import { describe, test, expect } from '@jest/globals';
import { EventEmitter } from 'events';
import { attachConsoleTracker, getConsoleLogs, clearConsoleLogs, MAX_CONSOLE_LOGS } from '../../lib/tab-logs.js';
import { attachNetworkTracker, getNetworkRequests, clearNetworkRequests, MAX_NETWORK_REQUESTS } from '../../lib/tab-network.js';

describe('tab-logs', () => {
  function makeMockTabState() {
    const page = new EventEmitter();
    const tabState = { page };
    attachConsoleTracker(tabState);
    return { tabState, page };
  }

  test('captures console messages with type, text, location, timestamp', () => {
    const { tabState, page } = makeMockTabState();
    page.emit('console', {
      type: () => 'warn',
      text: () => 'Deprecation warning',
      location: () => ({ url: 'https://example.com/app.js', lineNumber: 42, columnNumber: 10 }),
    });

    const res = getConsoleLogs(tabState);
    expect(res.count).toBe(1);
    expect(res.total).toBe(1);
    expect(res.logs[0]).toMatchObject({
      type: 'warn',
      text: 'Deprecation warning',
      location: { url: 'https://example.com/app.js', lineNumber: 42, columnNumber: 10 },
    });
    expect(typeof res.logs[0].timestamp).toBe('number');
  });

  test('captures pageerror events as error type', () => {
    const { tabState, page } = makeMockTabState();
    const err = new Error('Uncaught ReferenceError: foo is not defined');
    page.emit('pageerror', err);

    const res = getConsoleLogs(tabState);
    expect(res.count).toBe(1);
    expect(res.logs[0]).toMatchObject({
      type: 'error',
      text: expect.stringContaining('foo is not defined'),
    });
  });

  test('filters by types', () => {
    const { tabState, page } = makeMockTabState();
    page.emit('console', { type: () => 'log', text: () => 'msg 1' });
    page.emit('console', { type: () => 'error', text: () => 'msg 2' });
    page.emit('console', { type: () => 'warn', text: () => 'msg 3' });

    const errorsOnly = getConsoleLogs(tabState, { types: 'error' });
    expect(errorsOnly.count).toBe(1);
    expect(errorsOnly.logs[0].text).toBe('msg 2');

    const multi = getConsoleLogs(tabState, { types: ['log', 'warn'] });
    expect(multi.count).toBe(2);
  });

  test('limits and clears logs', () => {
    const { tabState, page } = makeMockTabState();
    for (let i = 0; i < 5; i++) {
      page.emit('console', { type: () => 'log', text: () => `msg ${i}` });
    }

    const limited = getConsoleLogs(tabState, { limit: 2 });
    expect(limited.count).toBe(2);
    expect(limited.logs[0].text).toBe('msg 3');
    expect(limited.logs[1].text).toBe('msg 4');

    const clearedRes = getConsoleLogs(tabState, { clear: true });
    expect(clearedRes.total).toBe(5);

    const afterClear = getConsoleLogs(tabState);
    expect(afterClear.total).toBe(0);
  });

  test('clearing with types filter preserves other log levels', () => {
    const { tabState, page } = makeMockTabState();
    page.emit('console', { type: () => 'log', text: () => 'info message' });
    page.emit('console', { type: () => 'error', text: () => 'error 1' });
    page.emit('console', { type: () => 'error', text: () => 'error 2' });

    const errors = getConsoleLogs(tabState, { types: 'error', clear: true });
    expect(errors.count).toBe(2);
    expect(tabState.consoleLogs).toHaveLength(1);
    expect(tabState.consoleLogs[0].text).toBe('info message');
  });

  test('clearConsoleLogs clears logs directly', () => {
    const { tabState, page } = makeMockTabState();
    page.emit('console', { type: () => 'log', text: () => 'test' });
    expect(clearConsoleLogs(tabState)).toBe(1);
    expect(tabState.consoleLogs).toHaveLength(0);
  });
});

describe('tab-network', () => {
  function makeMockTabState() {
    const page = new EventEmitter();
    const tabState = { page };
    attachNetworkTracker(tabState);
    return { tabState, page };
  }

  test('captures requests and matching responses', () => {
    const { tabState, page } = makeMockTabState();
    const mockReq = {
      url: () => 'https://api.example.com/data',
      method: () => 'POST',
      resourceType: () => 'fetch',
      headers: () => ({ 'content-type': 'application/json' }),
      postData: () => '{"query":"test"}',
    };
    page.emit('request', mockReq);

    let res = getNetworkRequests(tabState);
    expect(res.count).toBe(1);
    expect(res.requests[0]).toMatchObject({
      url: 'https://api.example.com/data',
      method: 'POST',
      resourceType: 'fetch',
      postData: '{"query":"test"}',
      status: null,
    });

    const mockRes = {
      request: () => mockReq,
      status: () => 200,
      statusText: () => 'OK',
      ok: () => true,
      headers: () => ({ 'content-type': 'application/json' }),
    };
    page.emit('response', mockRes);
    page.emit('requestfinished', mockReq);

    res = getNetworkRequests(tabState);
    expect(res.requests[0]).toMatchObject({
      status: 200,
      statusText: 'OK',
      ok: true,
    });
    expect(typeof res.requests[0].durationMs).toBe('number');
  });

  test('handles requestfailed', () => {
    const { tabState, page } = makeMockTabState();
    const mockReq = {
      url: () => 'https://api.example.com/fail',
      method: () => 'GET',
      resourceType: () => 'xhr',
      headers: () => ({}),
      postData: () => null,
      failure: () => ({ errorText: 'net::ERR_CONNECTION_REFUSED' }),
    };
    page.emit('request', mockReq);
    page.emit('requestfailed', mockReq);

    const res = getNetworkRequests(tabState);
    expect(res.count).toBe(1);
    expect(res.requests[0]).toMatchObject({
      failure: 'net::ERR_CONNECTION_REFUSED',
    });
  });

  test('filters by resourceTypes and status', () => {
    const { tabState, page } = makeMockTabState();
    const req1 = { url: () => 'https://x.com/a.js', method: () => 'GET', resourceType: () => 'script', headers: () => ({}) };
    const req2 = { url: () => 'https://x.com/api', method: () => 'GET', resourceType: () => 'fetch', headers: () => ({}) };
    page.emit('request', req1);
    page.emit('response', { request: () => req1, status: () => 200, statusText: () => 'OK', ok: () => true, headers: () => ({}) });

    page.emit('request', req2);
    page.emit('response', { request: () => req2, status: () => 404, statusText: () => 'Not Found', ok: () => false, headers: () => ({}) });

    const fetchOnly = getNetworkRequests(tabState, { resourceTypes: 'fetch' });
    expect(fetchOnly.count).toBe(1);
    expect(fetchOnly.requests[0].url).toBe('https://x.com/api');

    const status200 = getNetworkRequests(tabState, { status: '200' });
    expect(status200.count).toBe(1);
    expect(status200.requests[0].url).toBe('https://x.com/a.js');

    const failed = getNetworkRequests(tabState, { status: 'failed' });
    expect(failed.count).toBe(1);
    expect(failed.requests[0].url).toBe('https://x.com/api');
  });

  test('clearing with resourceTypes filter preserves other requests', () => {
    const { tabState, page } = makeMockTabState();
    const docReq = { url: () => 'https://x.com/index.html', method: () => 'GET', resourceType: () => 'document', headers: () => ({}) };
    const xhrReq = { url: () => 'https://x.com/api/data', method: () => 'POST', resourceType: () => 'xhr', headers: () => ({}) };
    page.emit('request', docReq);
    page.emit('request', xhrReq);

    const xhrs = getNetworkRequests(tabState, { resourceTypes: 'xhr', clear: true });
    expect(xhrs.count).toBe(1);
    expect(xhrs.requests[0].url).toBe('https://x.com/api/data');

    expect(tabState.networkRequests).toHaveLength(1);
    expect(tabState.networkRequests[0].url).toBe('https://x.com/index.html');
  });

  test('handles requestfinished before response safely without losing data', () => {
    const { tabState, page } = makeMockTabState();
    const mockReq = {
      url: () => 'https://api.example.com/fast',
      method: () => 'GET',
      resourceType: () => 'fetch',
      headers: () => ({}),
      postData: () => null,
    };
    page.emit('request', mockReq);
    // 乱序：requestfinished 先触发
    page.emit('requestfinished', mockReq);
    // response 稍后到达
    page.emit('response', {
      request: () => mockReq,
      status: () => 204,
      statusText: () => 'No Content',
      ok: () => true,
      headers: () => ({}),
    });

    const res = getNetworkRequests(tabState);
    expect(res.count).toBe(1);
    expect(res.requests[0].status).toBe(204);
    expect(res.requests[0].ok).toBe(true);
    expect(typeof res.requests[0].durationMs).toBe('number');
  });

  test('clearNetworkRequests clears requests directly', () => {
    const { tabState, page } = makeMockTabState();
    page.emit('request', { url: () => 'https://x.com/1', method: () => 'GET', resourceType: () => 'document', headers: () => ({}) });
    expect(clearNetworkRequests(tabState)).toBe(1);
    expect(tabState.networkRequests).toHaveLength(0);
  });
});
