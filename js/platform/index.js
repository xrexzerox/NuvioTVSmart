import { browserAdapter } from "./adapters/browserAdapter.js";
import { webosAdapter } from "./adapters/webosAdapter.js";
import { tizenAdapter } from "./adapters/tizenAdapter.js";

const ADAPTERS = {
  browser: browserAdapter,
  webos: webosAdapter,
  tizen: tizenAdapter
};

// Some webOS builds report the marketing generation ("webOS 23") while others
// report the release year ("webOS.TV-2023"). A two-digit capture reads the
// year form as generation 20, so collapse the year onto the generation.
function normalizeWebOsVersionToken(value) {
  const text = String(value ?? "").trim();
  const numeric = Number(text);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  if (text.length === 4 && numeric >= 2000) {
    return numeric - 2000;
  }
  return numeric;
}

// Chromium -> webOS generation. Must stay aligned with
// getWebOsReleaseYear() in js/platform/tvRuntimePerformance.js.
function webOsGenerationForChromium(chromiumMajor) {
  if (chromiumMajor <= 53) return 3;
  if (chromiumMajor <= 68) return 4;
  if (chromiumMajor <= 79) return 5;
  if (chromiumMajor <= 87) return 6;
  if (chromiumMajor <= 94) return 22;
  if (chromiumMajor <= 108) return 23;
  if (chromiumMajor <= 120) return 24;
  return 25;
}

function parseWebOsMajorVersion() {
  const candidates = [
    String(globalThis.PalmSystem?.deviceInfo || ""),
    String(globalThis.webOSSystem?.deviceInfo || ""),
    String(globalThis.navigator?.userAgent || "")
  ].filter(Boolean);

  // Two passes on purpose. An explicit generation token ("webOS 23",
  // "webOS.TV-2023") outranks the Chromium-version fallback, so it wins even
  // when it only appears in a later candidate. The previous single pass also
  // gated the fallback behind a test against the pattern's own source text,
  // which never matched an escaped slash, so the generation mapping below was
  // dead code and callers received the raw Chromium major (108 instead of 23).
  // `(?!\d)` keeps a 4-digit year from being read as its leading two digits.
  const generationPatterns = [
    /web0s\.tv[\s._/-]?(\d{1,4})(?!\d)/i,
    /webos\.tv[\s._/-]?(\d{1,4})(?!\d)/i,
    /web0s[\s._/-]?(\d{1,4})(?!\d)/i,
    /webos[\s._/-]?(\d{1,4})(?!\d)/i
  ];
  for (const candidate of candidates) {
    for (const pattern of generationPatterns) {
      const value = normalizeWebOsVersionToken(candidate.match(pattern)?.[1]);
      if (value > 0) {
        return value;
      }
    }
  }

  const chromiumPatterns = [/chromium\/(\d{2,3})/i, /chrome\/(\d{2,3})/i];
  for (const candidate of candidates) {
    for (const pattern of chromiumPatterns) {
      const value = Number(candidate.match(pattern)?.[1] || 0);
      if (Number.isFinite(value) && value > 0) {
        return webOsGenerationForChromium(value);
      }
    }
  }
  return 0;
}

function detectPlatformName() {
  const override = String(globalThis.__NUVIO_PLATFORM__ || "")
    .trim()
    .toLowerCase();
  if (override && ADAPTERS[override]) {
    return override;
  }
  const searchParams = String(globalThis.location?.search || "").toLowerCase();
  if (searchParams.includes("wrapper=tizen")) {
    return "tizen";
  }
  const userAgent = String(globalThis.navigator?.userAgent || "").toLowerCase();
  if (globalThis.webOS || globalThis.PalmSystem || globalThis.webOSSystem) {
    return "webos";
  }
  if (userAgent.includes("webos") || userAgent.includes("web0s")) {
    return "webos";
  }
  const webapis = globalThis.webapis || {};
  if (
    globalThis.tizen ||
    globalThis.avplay ||
    webapis.avplay ||
    webapis.avPlay ||
    webapis.productinfo ||
    userAgent.includes("tizen")
  ) {
    return "tizen";
  }
  return "browser";
}

function getAdapter() {
  if (!Platform.current) {
    Platform.current = ADAPTERS[detectPlatformName()];
  }
  return Platform.current;
}

export const Platform = {
  current: null,

  init() {
    const adapter = getAdapter();
    adapter.init?.();
    return adapter;
  },

  getName() {
    return getAdapter().name;
  },

  isWebOS() {
    return this.getName() === "webos";
  },

  getWebOsMajorVersion() {
    if (!this.isWebOS()) {
      return 0;
    }
    return parseWebOsMajorVersion();
  },

  isTizen() {
    return this.getName() === "tizen";
  },

  isBrowser() {
    return this.getName() === "browser";
  },

  exitApp() {
    if (globalThis.document && typeof globalThis.CustomEvent === "function") {
      const beforeExitEvent = new CustomEvent("nuvio:beforeExitApp", {
        cancelable: true
      });
      globalThis.document.dispatchEvent(beforeExitEvent);
      if (beforeExitEvent.defaultPrevented) {
        return false;
      }
    }
    return getAdapter().exitApp();
  },

  isBackEvent(event) {
    return getAdapter().isBackEvent(event);
  },

  normalizeKey(event) {
    return getAdapter().normalizeKey(event);
  },

  getDeviceLabel() {
    return getAdapter().getDeviceLabel();
  },

  getCapabilities() {
    return getAdapter().getCapabilities();
  },

  prepareVideoElement(videoElement) {
    return getAdapter().prepareVideoElement?.(videoElement);
  }
};
