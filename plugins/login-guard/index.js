/**
 * login-guard plugin — login-flow verification semantics ported from ego-lite.
 *
 * Two capabilities, both scoped per tab and reachable over HTTP when this
 * plugin is enabled (see camofox.config.json):
 *
 *   POST /verification/challenge  { userId, tabId }
 *     -> detect reCAPTCHA / hCaptcha / Turnstile / Geetest / Aliyun / Tencent /
 *        generic slider widgets on the page. For sliders it returns the handle
 *        box + a suggested horizontal delta that can be fed straight to
 *        POST /tabs/:tabId/drag (start + deltaX) for a trusted gesture.
 *
 *   POST /verification/dialog     { userId, tabId, policy?, reset? }
 *     -> get/set the native-JS-dialog policy (`dismiss` | `accept` | `auto`)
 *        and read the last captured dialog. `beforeunload` is always accepted
 *        so navigation can proceed.
 *
 * The dialog handler is installed on every tab via the `tab:created` event, so
 * a page that pops a confirm/prompt is recorded even when the caller did not
 * arm anything first. State lives per-page in a WeakMap (no leaks on close).
 *
 * Routes are intentionally plugin routes (not core routes): they are not part
 * of the OpenAPI/MCP parity contract, mirroring the youtube/vnc plugins.
 */

import {
  DIALOG_POLICIES,
  MAX_DOMAIN_POLICIES,
  findChallengeWidgets,
  findPuzzleGap,
  findTabState,
  installDialogHandler,
  matchHostPolicyKey,
  normalizeDialogPolicy,
  normalizeHost,
  resolveDialogPolicy,
  validatePolicyDomain,
} from '../../lib/verification.js';

export async function register(app, ctx) {
  const { events, sessions, normalizeUserId, auth, log, safeError } = ctx;

  // page -> { dialogPolicy, dialogPolicyByDomain, lastDialog, __dialogHandlerInstalled }
  const stateByPage = new WeakMap();

  function getState(page) {
    let state = stateByPage.get(page);
    if (!state) {
      state = { dialogPolicy: 'dismiss', dialogPolicyByDomain: Object.create(null), lastDialog: null };
      stateByPage.set(page, state);
      installDialogHandler(page, state, {
        onDialog: (record) => {
          try { events.emit('tab:dialog', record); } catch { /* fire-and-forget */ }
        },
      });
    }
    return state;
  }

  /** Effective policy + a bounded view of the domain overrides for a page. */
  function policyView(state, page) {
    let host = '';
    try { host = normalizeHost(page?.url?.() || ''); } catch { /* noop */ }
    const overrides = state.dialogPolicyByDomain || {};
    const entries = Object.entries(overrides)
      .filter(([, policy]) => DIALOG_POLICIES.includes(policy))
      .slice(0, MAX_DOMAIN_POLICIES);
    const matchedKey = matchHostPolicyKey(overrides, host);
    return {
      host,
      effectivePolicy: resolveDialogPolicy(state, host),
      domainPolicyCount: Object.keys(overrides).length,
      domainPolicyLimit: MAX_DOMAIN_POLICIES,
      hostPolicy: matchedKey ? { key: matchedKey, policy: overrides[matchedKey] } : null,
      dialogPolicyByDomain: Object.fromEntries(entries),
    };
  }

  // Attach a dialog handler as soon as any managed tab (or popup) appears.
  events.on('tab:created', ({ page }) => {
    if (page) getState(page);
  });

  function resolve(userId, tabId) {
    if (!userId || !tabId) return { error: 'userId and tabId required', status: 400 };
    const found = findTabState(sessions, normalizeUserId(userId), tabId);
    if (!found) return { error: 'tab not found', status: 404 };
    return found;
  }

  app.post('/verification/challenge', auth(), async (req, res) => {
    const resolved = resolve(req.body?.userId, req.body?.tabId);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
    try {
      const page = resolved.tabState.page;
      const state = getState(page);
      const result = await findChallengeWidgets(page);
      if (result.error) {
        log('warn', 'challenge inspection failed', { error: result.error });
      }
      res.json({
        ok: !result.error,
        tabId: req.body.tabId,
        url: result.url,
        title: result.title,
        count: result.count,
        challenges: result.challenges,
        dialogPolicy: state.dialogPolicy,
        ...policyView(state, page),
        lastDialog: state.lastDialog,
        ...(result.error ? { error: result.error } : {}),
      });
    } catch (err) {
      log('error', 'challenge inspect threw', { error: err.message });
      res.status(500).json({ error: safeError(err) });
    }
  });

  app.post('/verification/dialog', auth(), async (req, res) => {
    const resolved = resolve(req.body?.userId, req.body?.tabId);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
    try {
      const page = resolved.tabState.page;
      const state = getState(page);
      const body = req.body || {};

      if (body.policy !== undefined && !DIALOG_POLICIES.includes(body.policy)) {
        return res.status(400).json({ error: `policy must be one of: ${DIALOG_POLICIES.join(', ')}` });
      }

      // Domain-scoped overrides: `{ domain, policy }` sets one host (and its
      // subdomains via `*.host`), `clearDomain` removes it, `clearDomains`
      // removes every override. This keeps `accept` from auto-approving every
      // confirm on every site the agent happens to visit.
      if (body.domain !== undefined) {
        const parsed = validatePolicyDomain(body.domain);
        if (!parsed.ok) {
          return res.status(400).json({ error: parsed.error, code: 'invalid_domain' });
        }
        if (body.policy === undefined) {
          return res.status(400).json({
            error: 'domain requires a policy (dismiss | accept | auto)',
            code: 'policy_required',
          });
        }
        const existing = Object.prototype.hasOwnProperty.call(state.dialogPolicyByDomain, parsed.key);
        if (!existing && Object.keys(state.dialogPolicyByDomain).length >= MAX_DOMAIN_POLICIES) {
          return res.status(400).json({
            error: `too many domain policies (max ${MAX_DOMAIN_POLICIES}); clear some with clearDomain/clearDomains first`,
            code: 'too_many_domain_policies',
            limit: MAX_DOMAIN_POLICIES,
          });
        }
        state.dialogPolicyByDomain[parsed.key] = normalizeDialogPolicy(body.policy);
      }
      if (body.clearDomain !== undefined) {
        const parsed = validatePolicyDomain(body.clearDomain);
        if (!parsed.ok) {
          return res.status(400).json({ error: parsed.error, code: 'invalid_domain' });
        }
        delete state.dialogPolicyByDomain[parsed.key];
      }
      if (body.clearDomains === true) {
        state.dialogPolicyByDomain = Object.create(null);
      }
      if (body.policy !== undefined && body.domain === undefined) {
        state.dialogPolicy = normalizeDialogPolicy(body.policy);
      }
      if (body.reset === true) state.lastDialog = null;

      res.json({
        ok: true,
        tabId: body.tabId,
        dialogPolicy: state.dialogPolicy,
        ...policyView(state, page),
        supportedPolicies: DIALOG_POLICIES,
        lastDialog: state.lastDialog,
      });
    } catch (err) {
      log('error', 'dialog control threw', { error: err.message });
      res.status(500).json({ error: safeError(err) });
    }
  });

  app.post('/verification/puzzle-gap', auth(), async (req, res) => {
    const resolved = resolve(req.body?.userId, req.body?.tabId);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
    try {
      const page = resolved.tabState.page;
      const options = {
        bgSelector: req.body?.bgSelector,
        pieceSelector: req.body?.pieceSelector,
        handleSelector: req.body?.handleSelector,
        // `auto` tries luma/ycbcr/hsv and keeps the best; edge fallback covers
        // gradient backgrounds where colour matching is ambiguous.
        colorMode: req.body?.colorMode,
        edgeFallback: req.body?.edgeFallback,
      };
      const result = await findPuzzleGap(page, options);
      res.json({
        tabId: req.body.tabId,
        ...result,
      });
    } catch (err) {
      log('error', 'puzzle-gap threw', { error: err.message });
      res.status(500).json({ error: safeError(err) });
    }
  });

  log('info', 'login-guard plugin: registered /verification/challenge, /verification/dialog, and /verification/puzzle-gap');
}

export default register;
