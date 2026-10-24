export const MAX_NETWORK_REQUESTS = 300;
const MAX_POST_DATA_LENGTH = 10240;

let requestCounter = 0;

export function attachNetworkTracker(tabState) {
  if (!tabState?.page?.on || tabState.networkTrackerAttached) return;
  tabState.networkTrackerAttached = true;
  if (!Array.isArray(tabState.networkRequests)) {
    tabState.networkRequests = [];
  }
  const reqMap = new WeakMap();

  tabState.page.on('request', (req) => {
    try {
      let postData = null;
      try {
        postData = typeof req.postData === 'function' ? req.postData() : null;
        if (typeof postData === 'string' && postData.length > MAX_POST_DATA_LENGTH) {
          postData = postData.slice(0, MAX_POST_DATA_LENGTH) + '... [truncated]';
        }
      } catch {
        // ignore
      }

      const id = `req_${++requestCounter}_${Date.now().toString(36)}`;
      const entry = {
        id,
        url: typeof req.url === 'function' ? req.url() : '',
        method: typeof req.method === 'function' ? req.method() : 'GET',
        resourceType: typeof req.resourceType === 'function' ? req.resourceType() : 'other',
        headers: typeof req.headers === 'function' ? req.headers() : {},
        postData,
        timestamp: Date.now(),
        status: null,
        statusText: null,
        ok: null,
        responseHeaders: null,
        durationMs: null,
        failure: null,
      };

      reqMap.set(req, entry);
      tabState.networkRequests.push(entry);
      if (tabState.networkRequests.length > MAX_NETWORK_REQUESTS) {
        tabState.networkRequests.shift();
      }
    } catch {
      // ignore
    }
  });

  tabState.page.on('response', (res) => {
    try {
      const req = res.request ? res.request() : null;
      const entry = req ? reqMap.get(req) : null;
      if (entry) {
        entry.status = typeof res.status === 'function' ? res.status() : null;
        entry.statusText = typeof res.statusText === 'function' ? res.statusText() : null;
        entry.ok = typeof res.ok === 'function' ? res.ok() : null;
        entry.responseHeaders = typeof res.headers === 'function' ? res.headers() : null;
        if (entry.durationMs == null) {
          entry.durationMs = Math.max(0, Date.now() - entry.timestamp);
        }
      }
    } catch {
      // ignore
    }
  });

  tabState.page.on('requestfailed', (req) => {
    try {
      const entry = reqMap.get(req);
      if (entry) {
        const failureObj = typeof req.failure === 'function' ? req.failure() : null;
        entry.failure = failureObj?.errorText || 'failed';
        entry.durationMs = Math.max(0, Date.now() - entry.timestamp);
      }
    } catch {
      // ignore
    }
  });

  tabState.page.on('requestfinished', (req) => {
    try {
      const entry = reqMap.get(req);
      if (entry) {
        entry.durationMs = Math.max(0, Date.now() - entry.timestamp);
      }
    } catch {
      // ignore
    }
  });
}

export function getNetworkRequests(tabState, { limit = 100, resourceTypes, status, clear = false } = {}) {
  const allRequests = Array.isArray(tabState?.networkRequests) ? tabState.networkRequests : [];
  const total = allRequests.length;

  let filtered = allRequests;
  if (resourceTypes) {
    const typeList = Array.isArray(resourceTypes)
      ? resourceTypes.map((t) => String(t).trim().toLowerCase())
      : String(resourceTypes)
          .split(',')
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean);
    if (typeList.length > 0) {
      filtered = filtered.filter((r) => typeList.includes(String(r.resourceType).toLowerCase()));
    }
  }

  if (status !== undefined && status !== null && status !== '') {
    const statusStr = String(status).toLowerCase();
    if (statusStr === 'failed') {
      filtered = filtered.filter((r) => r.failure !== null || (r.status !== null && r.status >= 400));
    } else {
      const statusCode = Number(statusStr);
      if (Number.isInteger(statusCode)) {
        filtered = filtered.filter((r) => r.status === statusCode);
      }
    }
  }

  const numericLimit = Number(limit);
  const effectiveLimit = Number.isFinite(numericLimit) && numericLimit > 0
    ? Math.min(numericLimit, MAX_NETWORK_REQUESTS)
    : 100;

  const requests = filtered.slice(-effectiveLimit);

  if (clear && Array.isArray(tabState?.networkRequests)) {
    if (resourceTypes || (status !== undefined && status !== null && status !== '')) {
      const returnedSet = new Set(requests);
      tabState.networkRequests = tabState.networkRequests.filter((r) => !returnedSet.has(r));
    } else {
      tabState.networkRequests = [];
    }
  }

  return {
    requests,
    count: requests.length,
    total,
  };
}

export function clearNetworkRequests(tabState) {
  const count = Array.isArray(tabState?.networkRequests) ? tabState.networkRequests.length : 0;
  if (tabState) {
    tabState.networkRequests = [];
  }
  return count;
}
