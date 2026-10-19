# uBlock Origin (UBO) offline install

camoufox-js bundles **uBlock Origin** as a default addon (ad/tracker blocking →
cleaner pages, fewer third-party fingerprint requests). It downloads the signed
XPI from `addons.mozilla.org` **inside `launchOptions()`**, which `server.js`
wraps in a **10s timeout** (`GEOIP_SETUP_TIMEOUT_MS`, `server.js:1102`).

When AMO is unreachable or slow, that download blows past 10s and **every browser
launch fails** with:

```
GeoIP setup timed out after 10000ms
```

Common causes:
- The egress IP is a cloud/datacenter ASN that **Mozilla's CDN blocks with HTTP 406**
  (e.g. Tencent Cloud). A real Firefox gets 406 too — it is IP/ASN reputation, not TLS.
- The proxy is flaky and the ~4.6 MB download can't complete in time.

## Fix: pre-seed the addon cache

`camoufox-js`'s `maybeDownloadAddons()` (`addons.js:61`) checks whether the addon
directory already exists and **skips the download** if so. So placing the extracted
XPI on disk makes launch fast and **network-independent**.

### One command

```bash
# from plugins/camofox-browser/
node scripts/install-ubo.mjs            # download from AMO (resumable) + extract + set config
node scripts/install-ubo.mjs ubo.xpi    # use a locally-downloaded XPI instead of downloading
node scripts/install-ubo.mjs --check    # only verify the cached addon is present/valid
node scripts/install-ubo.mjs --no-config# skip flipping disableDefaultAddons:false
```

The script resolves the addon dir using camoufox-js's own `INSTALL_DIR`, so it
always targets the right place. It also sets `"disableDefaultAddons": false` in
`camofox.config.json` (unless `--no-config`).

### Where it goes (Windows)

```
%LOCALAPPDATA%\camoufox\camoufox\Cache\addons\UBO\manifest.json
```

Gotcha: the dir is `camoufox\camoufox\Cache` (**double `camoufox` + `Cache`**), per
`camoufox-js/dist/pkgman.js` `userCacheDir()`. Putting it one level too high
(`...\camoufox\addons\UBO`) is silently ignored and the download-timeout bug returns.

### If AMO is blocked (HTTP 406)

Download the signed XPI on any network that reaches AMO (a normal home connection
works), then feed it to the script:

```bash
node scripts/install-ubo.mjs /path/to/ublock_origin-<ver>.xpi
```

The XPI must be the **Mozilla-signed** build (only AMO distributes it signed).
The script extracts it with camoufox-js's own `unzip()` and verifies `manifest.json`.

## After a camoufox / camoufox-js update

An update can wipe the cache. Re-run:

```bash
node scripts/install-ubo.mjs --check   # if MISSING, re-run the install command
```

Then restart the camofox server so it re-reads `camofox.config.json`.

## Verify it loaded

Open any page, then from the page context a tracker request should be blocked:

```js
// camofox evaluate
(async () => {
  const p = async (u) => { try { await fetch(u, { mode: 'no-cors' }); return 'ALLOWED'; } catch { return 'BLOCKED'; } };
  return JSON.stringify({
    tracker: await p('https://www.google-analytics.com/collect?v=1&t=event&tid=UA-0-0'),
    control: await p('https://example.com/'),
  });
})()
// expect: {"tracker":"BLOCKED","control":"ALLOWED"}
```
