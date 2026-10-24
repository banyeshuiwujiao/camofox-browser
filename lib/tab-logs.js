export const MAX_CONSOLE_LOGS = 500;

export function attachConsoleTracker(tabState) {
  if (!tabState?.page?.on || tabState.consoleTrackerAttached) return;
  tabState.consoleTrackerAttached = true;
  if (!Array.isArray(tabState.consoleLogs)) {
    tabState.consoleLogs = [];
  }

  tabState.page.on('console', (msg) => {
    try {
      let location = null;
      try {
        location = msg.location ? msg.location() : null;
      } catch {
        // ignore location error
      }
      const entry = {
        type: typeof msg.type === 'function' ? msg.type() : String(msg.type || 'log'),
        text: typeof msg.text === 'function' ? msg.text() : String(msg.text || ''),
        location,
        timestamp: Date.now(),
      };
      tabState.consoleLogs.push(entry);
      if (tabState.consoleLogs.length > MAX_CONSOLE_LOGS) {
        tabState.consoleLogs.shift();
      }
    } catch {
      // ignore
    }
  });

  tabState.page.on('pageerror', (err) => {
    try {
      const entry = {
        type: 'error',
        text: err?.message || String(err || 'Unknown error'),
        stack: err?.stack || null,
        timestamp: Date.now(),
      };
      tabState.consoleLogs.push(entry);
      if (tabState.consoleLogs.length > MAX_CONSOLE_LOGS) {
        tabState.consoleLogs.shift();
      }
    } catch {
      // ignore
    }
  });
}

export function getConsoleLogs(tabState, { limit = 100, types, clear = false } = {}) {
  const allLogs = Array.isArray(tabState?.consoleLogs) ? tabState.consoleLogs : [];
  const total = allLogs.length;

  let filtered = allLogs;
  if (types) {
    const typeList = Array.isArray(types)
      ? types.map((t) => String(t).trim().toLowerCase())
      : String(types)
          .split(',')
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean);
    if (typeList.length > 0) {
      filtered = filtered.filter((log) => typeList.includes(String(log.type).toLowerCase()));
    }
  }

  const numericLimit = Number(limit);
  const effectiveLimit = Number.isFinite(numericLimit) && numericLimit > 0
    ? Math.min(numericLimit, MAX_CONSOLE_LOGS)
    : 100;

  const logs = filtered.slice(-effectiveLimit);

  if (clear && Array.isArray(tabState?.consoleLogs)) {
    if (types) {
      const returnedSet = new Set(logs);
      tabState.consoleLogs = tabState.consoleLogs.filter((l) => !returnedSet.has(l));
    } else {
      tabState.consoleLogs = [];
    }
  }

  return {
    logs,
    count: logs.length,
    total,
  };
}

export function clearConsoleLogs(tabState) {
  const count = Array.isArray(tabState?.consoleLogs) ? tabState.consoleLogs.length : 0;
  if (tabState) {
    tabState.consoleLogs = [];
  }
  return count;
}
