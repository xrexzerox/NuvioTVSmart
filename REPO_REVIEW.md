# NuvioTVSmart Repository Review — LG webOS 23 (Devant 32STW101)

Review date: 2026-09-29
Branch: `arena/01a0ec6f-nuviotvsmart`
Base commit: `81f9048`
Scope: runtime lag on a webOS 23 HD Ready TV, plus the correctness defects found while
tracing it.

---

## 1. What the target device actually is

`32STW101` is not an LG-branded set. It is a **Devant 32-inch "HD Smart TV" powered by
LG webOS Hub**, and its specifications are the important part of this review:

| Property               | Value                                                |
| ---------------------- | ---------------------------------------------------- |
| Model                  | 32STW101                                             |
| Panel                  | 32", Direct LED, 60 Hz                               |
| **Display resolution** | **1366 x 768 (HD Ready)**                            |
| Operating system       | webOS (LG webOS Hub, licensed to third-party brands) |
| Audio                  | 10 W x 2, Dolby Digital / Dolby Digital Plus         |
| Connectivity           | Dual-band Wi-Fi, Bluetooth                           |

The decisive detail is `1366 x 768`. The application is authored against a **1920 x 1080
CSS canvas** (`appinfo.json` declares `"resolution": "1920x1080"`, and the stylesheet
tokens are documented as "dp values x2 for the 1920px Smart-TV canvas"). On this panel
every frame the app produces is shaded at 1080p by the SoC and then downscaled by the
compositor. That is the single most expensive thing a TV UI can do on a budget SoC, and it
is not something the previous performance policy accounted for.

### Why the previous policy misclassified this device

`js/platform/tvRuntimePerformance.js` decided the performance tier **only** from the
runtime generation (TV year and Chromium major):

```js
modernTvYear: 2022,
modernChromiumMajor: 85
```

Traced against real webOS Hub reporting:

1. `readWebOsMajorVersion()` looks for a generation token. The webOS Hub user agent is
   `Mozilla/5.0 (Web0S; Linux/SmartTV) ... Chrome/108.0.5359.156 Safari/537.36` — the
   `Web0S` token carries **no** generation digits, so no match.
2. The Chromium fallback mapped `108` to `tvYear = 2024`.
3. `2024 >= modernTvYear (2022)` and `108 >= modernChromiumMajor (85)`.

Result: `isLegacyTvRuntime = false` -> `isPerformanceConstrained = false`.

So a 1366 x 768 budget panel was treated as a **current flagship** and received the full
heavy rendering path. Everything downstream keys off that one flag, which is why a single
misclassification produced lag in many unrelated places:

| Consumer                             | Heavy path (what this device got)                   | Constrained path          |
| ------------------------------------ | --------------------------------------------------- | ------------------------- |
| `applyPerformanceMode` (`js/app.js`) | `modern-sidebar-blur-capable` -> live backdrop blur | blur disabled             |
| `dpadRepeatThrottle.js`              | unthrottled key repeat                              | throttled repeat          |
| `homeScreenHelpers-14`               | 5 eager image rows                                  | 3 eager rows              |
| `homeScreenHelpers-10`               | 200-entry enrichment cache                          | 50-entry cache            |
| `homeScreenHelpers-12`               | eager Continue Watching artwork                     | deferred artwork          |
| `homeScreenHelpers-06`               | trailer resolution enabled                          | skipped                   |
| `homeScreenMethods-03`               | animated scrolling                                  | instant scroll            |
| `addonLogoCache.js`                  | high concurrency + large cache                      | reduced concurrency/cache |
| `watchProgressRepository.js`         | 1.5 s poll                                          | 15 s poll                 |
| `screen.js`                          | route transition animations                         | transitions skipped       |
| `getTvHeroTransitionMode`            | two full-screen artwork layers (crossfade)          | one layer                 |

---

## 2. Defects found and fixed

### 2.1 Performance tier ignored panel resolution (root cause of the lag)

`TV_RUNTIME_PERFORMANCE_THRESHOLDS` now carries a panel-resolution signal, and the profile
reports it separately from the generation:

```js
lowResolutionPanelMaxWidth: 1400;
// ...
isLowResolutionPanel = panelPixelWidth > 0 && panelPixelWidth <= lowResolutionPanelMaxWidth;
isPerformanceConstrained = isLegacyTvRuntime || isLowResolutionPanel;
```

`readPanelPixelWidth()` takes the **smallest** of `screen.width`, `innerWidth` and
`documentElement.clientWidth`, so the tier is still detected whether the runtime presents a
1366 px viewport or renders a 1920 px canvas scaled onto the 1366 px panel.

The change is **upgrade-only**: a 1920 x 1080 device reports `panelPixelWidth` 1920, keeps
`isPerformanceConstrained: false`, and is unaffected. Desktop browsers are excluded
entirely (`isTvRuntime` is false).

Verified behaviour:

| Scenario                            | constrained | hero mode        |
| ----------------------------------- | ----------- | ---------------- |
| webOS 23, 1920 canvas               | `false`     | crossfade        |
| **webOS 23, 1366 panel (32STW101)** | **`true`**  | **single-layer** |
| webOS 23, panel 1366 / canvas 1920  | `true`      | single-layer     |
| webOS 5 (Chromium 68)               | `true`      | single-layer     |
| Tizen 6.5 (Chromium 85)             | `false`     | crossfade        |
| Desktop browser                     | `false`     | crossfade        |

### 2.2 The Chromium -> webOS generation mapping was dead code

`parseWebOsMajorVersion()` in `js/platform/index.js` decided whether a match came from a
Chromium pattern by testing the pattern against **its own source text**:

```js
if (/chrom(e|ium)\//i.test(pattern.source)) {
  if (value <= 108) return 23;
  // ...
}
return value;
```

The `pattern.source` of `/chrome\/(\d{2,3})/i` is the string `chrome\/(\d{2,3})`. In that
text the `/` is preceded by a backslash, so the guard `chrom(e|ium)\/` never matched and
the mapping branch was unreachable:

```
pattern.source  =  "chrome\\/(\\d{2,3})"
/chrom(e|ium)\//.test(pattern.source)  ->  false
```

Every webOS set whose user agent exposes only the Chromium version — i.e. all webOS Hub
devices, including this one — therefore received the **raw Chromium major** from
`Platform.getWebOsMajorVersion()`: `108` instead of `23`.

Consequences:

- `webOsMajorVersion` was wrong for webOS Hub and any device without an explicit token.
- The `legacy-webos38` compatibility class (`webOsMajorVersion <= 3`) could never be set
  from the Chromium fallback, so a webOS 3.x set reporting `Chrome/38` was read as
  generation 38 and lost its compatibility stylesheet.

Fixed by splitting the scan into two passes (explicit generation tokens first, Chromium
fallback second) and moving the mapping into `webOsGenerationForChromium()`. Verified:
`Chrome/108 -> 23`, `Chrome/120 -> 24`, `Chrome/94 -> 22`, `Chrome/68 -> 4`,
`Chrome/38 -> 3`.

### 2.3 `webOS.TV-<year>` was truncated to two digits

Every generation pattern captured `(\d{1,2})`. LG webOS device info reports the marketing
generation in `webOS.TV-2023` form, and a two-digit capture reads that as **generation 20**.

Fixed with `normalizeWebOsVersionToken()`, which maps a four-digit `20xx` token onto the
generation number. Patterns now use `(\d{1,4})(?!\d)`; the `(?!\d)` guard stops a four-digit
year from being read as its leading digits while still allowing single-digit generations
such as `webOS 6.0`. Verified: `webOS.TV-2023 -> 23`, `webOS 23 -> 23`, `webOS 6.0 -> 6`.

### 2.4 Chromium -> year fallback contradicted the generation table

In `getWebOsReleaseYear()` the Chromium fallback returned `2024` for Chromium 108 and
`2025` for 120, while the authoritative version table maps 108 to webOS 23 (2023) and 120
to webOS 24 (2024). The ladder is now aligned with `webOsGenerationForChromium()`. This is
the only signal a webOS Hub set provides, so the wrong year was the value being reported
for this device.

### 2.5 Every webOS pointer move was processed twice

`FocusEngine.init()` registered both listeners for webOS:

```js
document.addEventListener("mousemove", this.boundHandlePointerMove, true);
document.addEventListener("pointermove", this.boundHandlePointerMove, true);
```

webOS TV WebViews deliver one physical cursor movement through both events, so each frame
ran the hit-test path twice: a screen `onPointerMove` hook plus
`closest(".focusable")`, a second `closest()` over a six-selector list, and a
`getBoundingClientRect()` forced layout. The engine now binds `pointermove` when
`PointerEvent` exists and falls back to `mousemove` otherwise.

### 2.6 A resting Magic Remote forced layout every frame

`handlePointerMove` ran its `requestAnimationFrame` path for any event, including
sub-pixel drift from a remote sitting still. A cheap 3 px travel gate now drops idle
events before the frame is scheduled. Slow, genuine movement still accumulates and passes.

### 2.7 Permanent `will-change` layers were released only for legacy Tizen

Roughly twenty selectors promote a compositor layer for the lifetime of the screen
(`.home-sidebar`, `.home-nav-item`, `.modern-sidebar-shell`, `.settings-workspace`,
`.player-*`, `.profile-*`). The constrained fast path already disables the transitions
those promotions existed for, so the promotion only keeps extra GPU surfaces alive on a
budget panel. The nulling rule that previously applied to `.legacy-tizen` alone now also
covers `.performance-constrained`, which — after fix 2.1 — includes this device.

### 2.8 The webOS package was compiled against the Tizen JavaScript floor

`scripts/build.mjs` targeted `compatibilityPolicy.chromiumVersion` (**Chrome 56**, the
Tizen 4 floor) for every output, including the webOS IPK. The webOS package only has to run
on the webOS 5 baseline, `compatibilityPolicy.webOsChromiumVersion` (**Chrome 68**), which
the repository already declares. webOS 23 runs Chromium 108 natively, so the package was
shipping Chrome-56-only transpilation and a Chrome-56 polyfill set to the hardware that
needed neither.

The build now accepts `--platform=webos` and raises the JavaScript target only for that
pipeline; the bundled stylesheet deliberately stays on the shared conservative CSS floor.
Measured on this checkout:

| Artifact            | Before (Chrome 56) | After (Chrome 68) | Saved    |
| ------------------- | ------------------ | ----------------- | -------- |
| `app.bundle.js`     | 3,143,705 B        | 3,084,861 B       | 58,844 B |
| `core-js.bundle.js` | 165,129 B          | 113,538 B         | 51,591 B |

**~110 KB** less JavaScript to download, parse and evaluate on every start. The Tizen
target, and therefore the Tizen WGT, is unchanged — `npm run build` still uses the Chrome 56
floor and produces essentially the same output as before (3,144,786 B vs 3,143,705 B, the
difference being the source edits in this change).

---

## 3. Verification performed

- `npm run lint` — clean.
- `npm run build` (Tizen floor) — succeeds, output unchanged.
- `npm run build:webos` and `npm run package:webos` — succeeds; `space.nuvio.webos_1.2.1_all.ipk`
  produced and unpacked to confirm the reduced bundles are the ones actually shipped
  (`app.bundle.js` 3,084,861 B, `core-js.bundle.js` 113,538 B).
- Version/platform detection exercised across ten device profiles (webOS Hub 23, explicit
  `webOS 23`, `webOS.TV-2023`, webOS 4/5/6, Chromium 38/68/94/108/120) — all correct.
- Performance-profiling exercised across six device profiles, including the 1920 canvas
  regression case and the desktop-browser exclusion.

`npm test` is **not runnable in a fresh clone**: `package.json` points at
`tests/test-plugin-system.mjs` and `tests/test-plugin-localization.mjs`, but `tests/` is
listed in `.gitignore` and is not part of the repository. See finding 4.1.

---

## 4. Findings not fixed (out of scope, noted for follow-up)

### 4.1 `npm test` cannot run from a clone

`.gitignore` excludes `tests/`, yet `package.json` and `scripts/package-tizen.mjs` reference
it. Any CI job that runs the documented test command will fail on any checkout. Either the
test suite should be committed or the script should tolerate its absence.

### 4.2 The 1920 x 1080 canvas is still emitted for HD Ready panels

Fix 2.1 removes the _rendering_ cost of the mismatch (blur, animations, extra image rows,
extra artwork layers), but the app still lays out a 1920 x 1080 surface that the compositor
downscales to 1366 x 768. Re-authoring the layout against the real panel size is the
remaining structural win; it is a large, cross-cutting change and was not attempted here.

### 4.3 Resolution detection is fail-safe, not guaranteed

`readPanelPixelWidth()` takes the minimum of the three available signals. If a webOS Hub
build reports 1920 through all of them while driving a 1366 panel, the tier check will not
fire and behaviour falls back to exactly what it is today. Nothing regresses, but the fix
would not apply either. A `luna://com.webos.service.tv.systemproperty` query could confirm
the panel, at the cost of asynchronous work during startup.

### 4.4 Service bundling targets Node 8 for all webOS versions

`compatibilityPolicy.webOsServiceNodeVersion` is `8` and `stageService()` in
`scripts/package-webos.mjs` uses it for both bundled services. That is the correct floor for
webOS 5, but it also downlevels the service code on webOS 23. Unlike the app bundle the
service is short-lived and small, so the payoff is lower; not changed.

---

## 5. Files changed

| File                                  | Change                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `js/platform/tvRuntimePerformance.js` | Panel-resolution tier signal; Chromium->year ladder aligned with the version table; `webOS.TV-<year>` normalization |
| `js/platform/index.js`                | Two-pass version parse; restored Chromium->generation mapping (dead-code fix); year-token normalization             |
| `js/ui/navigation/focusEngine.js`     | Single pointer listener per webOS build; 3 px pointer travel gate                                                   |
| `css/components-60.css`               | Release promoted compositor layers on the constrained path                                                          |
| `scripts/build.mjs`                   | `--platform=webos` raises the JavaScript target to the webOS floor                                                  |
| `package.json`                        | New `build:webos` script; `package:webos` uses it                                                                   |
| `CHANGELOG.md`                        | 1.2.2 entry                                                                                                         |
| `README.md`                           | Documented the budget-panel performance tier                                                                        |
