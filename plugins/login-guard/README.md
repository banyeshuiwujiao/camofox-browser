# login-guard plugin

Login-flow verification helpers for camofox-browser. Ported from the semantics
observed in [citrolabs/ego-lite](https://github.com/citrolabs/ego-lite)
(see `docs/ego-lite-login-verification-notes.md` in the client config repo).

Two things every login automation eventually hits:

1. **"Verify you are human" widgets** — reCAPTCHA, hCaptcha, Cloudflare
   Turnstile, Geetest, Aliyun NC, Tencent, or a plain drag-slider.
2. **Native JavaScript dialogs** — `alert` / `confirm` / `prompt` /
   `beforeunload`. Playwright silently dismisses these by default, which is
   exactly the wrong default for "确认登录？" style confirms and for
   `beforeunload` navigation guards.

This plugin adds a thin, opt-in layer over the existing core drag endpoint and
the Playwright `page` event bus. It does **not** add any core routes, so the
OpenAPI / MCP parity gate is untouched (same pattern as the youtube/vnc plugins).

## Enable

Add it to `camofox.config.json`:

```json
{
  "plugins": {
    "youtube": { "enabled": true },
    "persistence": { "enabled": true },
    "login-guard": { "enabled": true }
  }
}
```

Or set `CAMOFOX_LOGIN_GUARD=1` (see `plugin.json.enableEnvVar`).

## API

### `POST /verification/challenge`

Body: `{ "userId": "...", "tabId": "..." }`

Detects challenge widgets on the tab's current page and returns, for each:

```json
{
  "ok": true,
  "count": 1,
  "challenges": [
    {
      "kind": "slider",
      "selector": "[class*=\"slide-verify\"]",
      "box": { "x": 320, "y": 480, "width": 300, "height": 40 },
      "center": { "x": 470, "y": 500 },
      "handle": { "selector": "#nc_1_n1z", "box": {...}, "center": { "x": 340, "y": 500 } },
      "suggestedDrag": { "start": { "x": 340, "y": 500 }, "deltaX": 266, "deltaY": 0 }
    }
  ],
  "dialogPolicy": "dismiss",
  "lastDialog": null
}
```

Feed `suggestedDrag.start` + `deltaX` straight into the trusted drag endpoint:

```bash
POST /tabs/{tabId}/drag
{ "userId": "...", "start": {"x":340,"y":500}, "deltaX": 266,
  "steps": 24, "durationMs": 900, "easing": "easeInOut", "jitterPx": 1.5,
  "overshootBounds": {"x":320,"y":480,"width":300,"height":40} }
```

`overshootBounds` is the challenge `box` (or the puzzle `bgBox`): the overshoot
peak is clamped inside that rect, so the "dart past the end" motion cannot
stray onto a neighbouring control even when the widget sits mid-page.

### `POST /verification/puzzle-gap`

Body: `{ "userId": "...", "tabId": "...", "bgSelector"?, "pieceSelector"?, "handleSelector"?, "colorMode"?, "edgeFallback"? }`

Locates the slider puzzle background/piece images, then scores every candidate
offset and returns the most likely gap:

```json
{ "ok": true, "deltaX": 186, "confidence": 0.88,
  "requestedColorMode": "auto", "colorMode": "ycbcr", "method": "color",
  "suggestedDrag": { "start": { "x": 340, "y": 500 }, "deltaX": 186, "easing": "easeInOut" } }
```

`colorMode` selects the pixel metric:

| mode | when to use |
|------|-------------|
| `luma` (default) | greyscale captchas — cheapest |
| `ycbcr` | the piece shares the background's brightness but not its colour |
| `hsv` | saturated / gradient backgrounds where luma is nearly flat |
| `auto` | tries all three and keeps the most separable match |

When colour matching is ambiguous (`quality < 0.35` or the best score is
large), `edgeFallback` (default `true`) retries with Sobel edge magnitudes and
keeps the better result (`method: "edge"`). Passing
`"edgeFallback": false` disables that second pass.

### `POST /verification/dialog`

Body: `{ "userId": "...", "tabId": "...", "policy"?, "domain"?, "clearDomain"?, "clearDomains"?, "reset"? }`

- `policy` alone — tab-wide default.
- `domain` + `policy` — override for one host, also matching its subdomains
  (store `*.example.com` to cover the whole suffix family). This is what keeps
  `accept` from auto-approving every confirm on every other site.
- `clearDomain` — remove one host override.
- `clearDomains: true` — remove all host overrides.
- `reset: true` — clear the remembered last dialog.

Domain keys are validated and capped:

| rule | value |
|------|-------|
| max overrides per tab | 32 (`400 too_many_domain_policies` beyond, `clearDomain` first) |
| max host length / label | 253 / 63 chars, letters+digits+hyphens |
| wildcard breadth | at least two labels: `*.example.com` ok, `*.com` → `400 invalid_domain` |

Policies:

- `dismiss` (default) — reproduce Playwright's silent-dismiss behaviour, but now
  the dialog is recorded.
- `accept` — accept `alert`/`confirm`/`prompt` (prompt keeps its default text).
- `auto` — accept everything; `beforeunload` is always accepted regardless of
  policy so navigation can proceed.

Returns `{ ok, dialogPolicy, dialogPolicyByDomain, domainPolicyCount, domainPolicyLimit, host, hostPolicy, effectivePolicy, supportedPolicies, lastDialog }`.
`effectivePolicy` is the value that will be applied to the current page's host;
`hostPolicy` is `{ key, policy }` for the matching override (or `null`).
`lastDialog` is `{ type, message, defaultPrompt, url, host, policy, decision, handled, at }`.

Set the policy **before** the action that triggers the dialog (e.g. set
`accept` ahead of clicking "确认登录", scoped with `"domain": "login.example.com"`),
because Playwright resolves the dialog the moment it appears.
