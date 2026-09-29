import { Platform } from "./index.js";
import { TizenCapabilities } from "./tizen/tizenCapabilities.js";

// The first common TV generation with a modern Chromium baseline is Samsung
// Tizen 6.5 / Chromium M85 (2022) and LG webOS TV 22 / Chromium M87 (2022).
// Keep this policy tied to the runtime generation, not the vendor name.
export const TV_RUNTIME_PERFORMANCE_THRESHOLDS = Object.freeze({
  modernTvYear: 2022,
  modernChromiumMajor: 85,
  // HD Ready (1366x768) panels ship on the budget tiers of every TV line,
  // including LG webOS Hub sets that otherwise report a current runtime
  // generation and a current Chromium build. Their SoC is far weaker than the
  // year/major-version baseline implies, so the generation check alone is not
  // enough to decide whether the expensive rendering path is affordable.
  lowResolutionPanelMaxWidth: 1400
});

const WEBOS_RELEASE_YEARS = Object.freeze({
  1: 2014,
  2: 2015,
  3: 2016,
  4: 2018,
  5: 2020,
  6: 2021
});
let cachedProfile = null;

function parseVersionParts(value) {
  const match = String(value || "")
    .trim()
    .match(/^(\d+)(?:\.(\d+))?/);
  if (!match) {
    return { major: 0, minor: 0 };
  }
  return {
    major: Number(match[1] || 0),
    minor: Number(match[2] || 0)
  };
}

function readChromiumMajorVersion() {
  const userAgent = String(globalThis.navigator?.userAgent || "");
  const match = userAgent.match(/(?:chrome|chromium)\/(\d{2,3})/i);
  const version = Number(match?.[1] || 0);
  return Number.isFinite(version) ? version : 0;
}

function readWebOsMajorVersion() {
  const candidates = [
    String(globalThis.PalmSystem?.deviceInfo || ""),
    String(globalThis.webOSSystem?.deviceInfo || ""),
    String(globalThis.navigator?.userAgent || "")
  ].filter(Boolean);
  // Kept in sync with parseWebOsMajorVersion() in js/platform/index.js.
  const patterns = [
    /web0s\.tv[\s._\-/]?(\d{1,4})(?!\d)/i,
    /webos\.tv[\s._\-/]?(\d{1,4})(?!\d)/i,
    /web0s[\s._\-/]?(\d{1,4})(?!\d)/i,
    /webos[\s._\-/]?(\d{1,4})(?!\d)/i
  ];
  for (const candidate of candidates) {
    for (const pattern of patterns) {
      const match = candidate.match(pattern);
      const version = match?.[1] ? normalizeWebOsVersionToken(match[1]) : 0;
      if (Number.isFinite(version) && version > 0) {
        return version;
      }
    }
  }
  return 0;
}

// webOS device info reports the marketing generation either as a bare number
// ("webOS 23") or as a release year ("webOS.TV-2023"). Both describe the same
// generation, so collapse the year form onto the generation number. A plain
// two-digit capture would read "webOS.TV-2023" as generation 20.
function normalizeWebOsVersionToken(value) {
  const text = String(value || "").trim();
  const numeric = Number(text);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  if (text.length === 4 && numeric >= 2000) {
    return numeric - 2000;
  }
  return numeric;
}

function readPanelPixelWidth() {
  const candidates = [
    Number(globalThis.screen?.width || 0),
    Number(globalThis.innerWidth || 0),
    Number(globalThis.document?.documentElement?.clientWidth || 0)
  ];
  const widths = candidates.filter((value) => Number.isFinite(value) && value > 0);
  return widths.length ? Math.min(...widths) : 0;
}

function getWebOsReleaseYear(webOsMajorVersion, chromiumMajorVersion) {
  const major = Number(webOsMajorVersion || 0);
  if (major >= 22 && major <= 99) {
    return 2000 + major;
  }
  if (WEBOS_RELEASE_YEARS[major]) {
    return WEBOS_RELEASE_YEARS[major];
  }

  // Must stay aligned with the Chromium -> webOS generation table in
  // js/platform/index.js. The plain "Web0S" user agent used by webOS Hub sets
  // has no generation token at all, so this fallback is the only signal those
  // devices provide.
  const chromium = Number(chromiumMajorVersion || 0);
  if (chromium > 0) {
    if (chromium <= 53) return 2016;
    if (chromium <= 68) return 2018;
    if (chromium <= 79) return 2020;
    if (chromium <= 87) return 2021;
    if (chromium <= 94) return 2022;
    if (chromium <= 108) return 2023;
    if (chromium <= 120) return 2024;
    return 2025;
  }
  return 0;
}

function getTizenReleaseYear(tizenVersion) {
  const { major, minor } = parseVersionParts(tizenVersion);
  if (major === 2) {
    return minor >= 4 ? 2016 : 2015;
  }
  if (major === 3) {
    return 2017;
  }
  if (major === 4) {
    return 2018;
  }
  if (major === 5) {
    return minor >= 5 ? 2020 : 2019;
  }
  if (major === 6) {
    return minor >= 5 ? 2022 : 2021;
  }
  if (major >= 7) {
    return 2016 + major;
  }
  return 0;
}

export function getTvRuntimePerformanceProfile({ forceRefresh = false } = {}) {
  if (cachedProfile && !forceRefresh) {
    return cachedProfile;
  }

  const isWebOS = Platform.isWebOS();
  const isTizen = Platform.isTizen();
  const isTvRuntime = isWebOS || isTizen;
  let chromiumMajorVersion = readChromiumMajorVersion();
  const panelPixelWidth = readPanelPixelWidth();
  if (!isTvRuntime) {
    cachedProfile = Object.freeze({
      isTvRuntime: false,
      platform: Platform.getName(),
      tvYear: 0,
      chromiumMajorVersion,
      tvYearKnown: false,
      chromiumVersionKnown: chromiumMajorVersion > 0,
      panelPixelWidth,
      isLowResolutionPanel: false,
      isLegacyTvRuntime: false,
      isPerformanceConstrained: false
    });
    return cachedProfile;
  }

  let tvYear = 0;

  if (isWebOS) {
    tvYear = getWebOsReleaseYear(readWebOsMajorVersion(), chromiumMajorVersion);
  } else if (isTizen) {
    const capabilities = TizenCapabilities.get();
    tvYear = getTizenReleaseYear(capabilities?.tizenVersion);
    chromiumMajorVersion = Number(capabilities?.chromiumMajorVersion || chromiumMajorVersion);
  }

  const { modernTvYear, modernChromiumMajor, lowResolutionPanelMaxWidth } =
    TV_RUNTIME_PERFORMANCE_THRESHOLDS;
  const tvYearKnown = tvYear > 0;
  const chromiumVersionKnown = chromiumMajorVersion > 0;
  const isLegacyByYear = tvYearKnown && tvYear < modernTvYear;
  const isLegacyByChromium = chromiumVersionKnown && chromiumMajorVersion < modernChromiumMajor;
  const isUnidentifiedRuntime = !tvYearKnown && !chromiumVersionKnown;
  const isLowResolutionPanel = panelPixelWidth > 0 && panelPixelWidth <= lowResolutionPanelMaxWidth;
  // A current runtime generation does not guarantee current hardware. Budget
  // HD Ready sets pair webOS 23 (or Tizen 7) with a low-tier SoC, so the panel
  // resolution is treated as a separate, upgrading-only signal.
  const isLegacyTvRuntime = isLegacyByYear || isLegacyByChromium || isUnidentifiedRuntime;

  cachedProfile = Object.freeze({
    isTvRuntime: true,
    platform: isWebOS ? "webos" : "tizen",
    tvYear,
    chromiumMajorVersion,
    tvYearKnown,
    chromiumVersionKnown,
    panelPixelWidth,
    isLowResolutionPanel,
    isLegacyTvRuntime,
    isPerformanceConstrained: isLegacyTvRuntime || isLowResolutionPanel
  });
  return cachedProfile;
}

export function resetTvRuntimePerformanceProfile() {
  cachedProfile = null;
}

// Android keeps the current hero scene alive while the next artwork is being
// prepared, then crossfades the settled scene. On constrained TV runtimes
// (including unidentified ones, which fail closed to constrained) and on all
// Samsung Tizen TVs, avoid allocating a second full-screen artwork layer:
// the Web fallback still waits for the asset and fades it in, but keeps only
// one image layer alive.
export function getTvHeroTransitionMode(profile = getTvRuntimePerformanceProfile()) {
  if (profile?.isTvRuntime && profile.isPerformanceConstrained) {
    return "single-layer";
  }
  try {
    if (
      globalThis?.document?.body?.classList?.contains("legacy-tizen") ||
      globalThis?.document?.documentElement?.classList?.contains("legacy-tizen")
    ) {
      return "single-layer";
    }
  } catch (_) {}
  return "crossfade";
}
