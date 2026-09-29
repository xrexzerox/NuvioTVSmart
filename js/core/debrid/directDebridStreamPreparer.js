import { DebridSettingsStore } from "../../data/local/debridSettingsStore.js";
import { selectAutoPlayStream, STREAM_AUTO_PLAY_MODE } from "../streams/streamAutoPlaySelector.js";
import { DirectDebridResolver } from "./directDebridResolver.js";

const MAX_BACKGROUND_PREPARES_PER_MINUTE = 6;
const MAX_BACKGROUND_PREPARES_PER_HOUR = 30;
const minuteStarts = [];
const hourStarts = [];

function prune(list, cutoffMs) {
  while (list.length && list[0] < cutoffMs) {
    list.shift();
  }
}

function consumeBudget() {
  const now = Date.now();
  prune(minuteStarts, now - 60 * 1000);
  prune(hourStarts, now - 60 * 60 * 1000);
  if (
    minuteStarts.length >= MAX_BACKGROUND_PREPARES_PER_MINUTE ||
    hourStarts.length >= MAX_BACKGROUND_PREPARES_PER_HOUR
  ) {
    return false;
  }
  minuteStarts.push(now);
  hourStarts.push(now);
  return true;
}

function isMagnetLink(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .startsWith("magnet:");
}

function playableStreamUrl(stream = {}) {
  return [stream.url, stream.externalUrl].find((value) => value && !isMagnetLink(value)) || null;
}

function torrentMagnetUri(stream = {}) {
  return [stream.url, stream.externalUrl].find((value) => isMagnetLink(value)) || null;
}

export function directDebridPreparationKey(stream = {}) {
  const resolve = stream.clientResolve || stream.raw?.clientResolve || null;
  const values = resolve
    ? [
        resolve.service,
        resolve.infoHash,
        resolve.fileIdx,
        resolve.filename,
        resolve.torrentName,
        resolve.magnetUri
      ]
    : [
        stream.addonName,
        stream.infoHash,
        torrentMagnetUri(stream),
        stream.fileIdx,
        playableStreamUrl(stream),
        stream.name,
        stream.title
      ];
  return values
    .map((value) =>
      String(value ?? "")
        .trim()
        .toLowerCase()
    )
    .join("|");
}

function searchableText(stream = {}) {
  return [stream.addonName, stream.name, stream.title, stream.description, stream.url]
    .map((value) => String(value || ""))
    .join(" ");
}

export function prioritizeDirectDebridCandidates(
  streams = [],
  {
    limit = 0,
    season = null,
    episode = null,
    playerSettings = {},
    debridSettings = null,
    installedAddonNames = new Set()
  } = {}
) {
  const normalizedLimit = Math.max(0, Math.trunc(Number(limit || 0)));
  if (!normalizedLimit) return [];
  const seen = new Set();
  const candidates = [];
  for (const stream of Array.isArray(streams) ? streams : []) {
    if (
      playableStreamUrl(stream) ||
      !DirectDebridResolver.canResolveStream(stream, { season, episode, settings: debridSettings })
    ) {
      continue;
    }
    const key = directDebridPreparationKey(stream);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    candidates.push({ stream, key });
  }
  if (!candidates.length) return [];

  const prioritized = [];
  const prioritizedKeys = new Set();
  const addCandidate = (candidate) => {
    if (!candidate || prioritized.length >= normalizedLimit || prioritizedKeys.has(candidate.key)) {
      return;
    }
    prioritized.push(candidate);
    prioritizedKeys.add(candidate.key);
  };
  const selected = selectAutoPlayStream(streams, {
    mode: playerSettings.streamAutoPlayMode,
    source: playerSettings.streamAutoPlaySource,
    regexPattern: playerSettings.streamAutoPlayRegex,
    installedAddonNames,
    selectedAddons: playerSettings.streamAutoPlaySelectedAddons,
    selectedPlugins: playerSettings.streamAutoPlaySelectedPlugins
  });
  const selectedKey = selected ? directDebridPreparationKey(selected) : "";
  addCandidate(candidates.find((candidate) => selectedKey && candidate.key === selectedKey));

  if (
    prioritized.length < normalizedLimit &&
    String(playerSettings.streamAutoPlayMode || "").toUpperCase() ===
      STREAM_AUTO_PLAY_MODE.REGEX_MATCH
  ) {
    let regex = null;
    try {
      regex = new RegExp(String(playerSettings.streamAutoPlayRegex || "").trim(), "i");
    } catch (_) {
      regex = null;
    }
    if (regex) {
      for (const candidate of candidates) {
        if (prioritized.length >= normalizedLimit) {
          break;
        }
        if (!prioritizedKeys.has(candidate.key) && regex.test(searchableText(candidate.stream))) {
          addCandidate(candidate);
        }
      }
    }
  }

  if (prioritized.length < normalizedLimit) {
    for (const candidate of candidates) {
      if (prioritized.length >= normalizedLimit) {
        break;
      }
      addCandidate(candidate);
    }
  }
  return prioritized.map((candidate) => candidate.stream);
}

export const DirectDebridStreamPreparer = {
  async prepare(
    streams = [],
    {
      season = null,
      episode = null,
      playerSettings = {},
      installedAddonNames = new Set(),
      onPrepared = null
    } = {}
  ) {
    const settings = DebridSettingsStore.get();
    const limit = Math.max(
      0,
      Math.min(5, Math.trunc(Number(settings.instantPlaybackPreparationLimit || 0)))
    );
    if (!settings.enabled || limit <= 0) {
      return;
    }
    const candidates = prioritizeDirectDebridCandidates(streams, {
      limit,
      season,
      episode,
      playerSettings,
      debridSettings: settings,
      installedAddonNames
    });

    for (const stream of candidates) {
      const cached = DirectDebridResolver.cachedPlayableStream(stream, {
        season,
        episode,
        settings
      });
      if (cached) {
        if (typeof onPrepared === "function") onPrepared(stream, cached);
        continue;
      }
      if (!consumeBudget()) {
        return;
      }
      const result = await DirectDebridResolver.resolve(stream, { season, episode }).catch(
        () => null
      );
      if (result?.status === "success" && result.stream?.url && typeof onPrepared === "function") {
        onPrepared(stream, result.stream);
      }
    }
  }
};
