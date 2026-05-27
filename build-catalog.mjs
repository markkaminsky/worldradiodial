#!/usr/bin/env node
// Build catalog.json from Radio Browser.
//
// Replaces the iOS app's cold-launch 543-request fan-out with one daily server-side build.
// Reads curation.json (sibling file) for fetch parameters; writes catalog.json next to it.
//
// What we do here:
//   1. For each (country / tag / name fragment / brand needle / english slice), fetch the
//      top-N stations from radio-browser.info ordered by clickcount.
//   2. Merge, dedup by stationuuid, sort by clickcount descending.
//   3. Write catalog.json — same shape iOS already decodes (no extra schema).
//
// What we DON'T do here:
//   - Block-list / religious / adult filtering. Those live in the app's CatalogRegionPolicy
//     against curation.json. Keeping editorial filtering on the client means we can update
//     the block list with a quick curation.json push without re-running this multi-minute job.
//   - Region-specific boost. The cron fetches the same slices for everyone; the prebuilt
//     catalog is global. Per-user region tuning (if needed later) can layer on top.
//
// Usage:
//   node build-catalog.mjs [--out catalog.json] [--curation curation.json]
//
// Exits non-zero if the catalog is suspiciously small — protects against committing a
// degraded snapshot when the API is having a bad day.

import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- Args ----------

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);

const CURATION_PATH = resolve(__dirname, args.curation ?? "curation.json");
const OUT_PATH = resolve(__dirname, args.out ?? "catalog.json");

// ---------- Tunables ----------

// Radio Browser is a free volunteer service; cap parallel requests so we're a polite client.
// 12 in flight is comfortably under typical public-API rate limits while still finishing
// a ~543-request build in well under a minute.
const MAX_CONCURRENT = 12;

// Per-request timeout. Hosts occasionally hang; bail and the slice is skipped (logged).
const REQUEST_TIMEOUT_MS = 30_000;

// API mirror rotation — same hosts the iOS client uses; first one to answer wins.
const API_HOSTS = [
  "https://de1.api.radio-browser.info",
  "https://fi1.api.radio-browser.info",
  "https://nl1.api.radio-browser.info",
];

// Lower-bound sanity check. A healthy catalog is 8–12k stations; if we land below this,
// something is wrong upstream and we should not overwrite the existing catalog.
const MIN_HEALTHY_STATION_COUNT = 3_000;

// Field whitelist matching the Swift `RadioStation` CodingKeys exactly. Radio Browser
// returns extra fields (bitrate, codec, hls, etc.) we don't decode — drop them so the
// committed catalog.json is as small as we can make it.
const KEEP_FIELDS = new Set([
  "stationuuid",
  "name",
  "url",
  "url_resolved",
  "favicon",
  "tags",
  "country",
  "countrycode",
  "state",
  "language",
  "votes",
  "lastcheckok",
  "geo_lat",
  "geo_long",
  "clickcount",
]);

// ---------- HTTP ----------

async function fetchSliceOnce(host, params) {
  const url = new URL("/json/stations/search", host);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      url.searchParams.set(k, String(v));
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "WorldRadioDial-Aggregator/1.0 (+https://github.com/markkaminsky/worldradiodial)",
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error("Response was not a JSON array");
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** Try each mirror in order; first success wins. Returns [] if all mirrors fail. */
async function fetchSlice(params, label) {
  let lastErr;
  for (const host of API_HOSTS) {
    try {
      return await fetchSliceOnce(host, params);
    } catch (err) {
      lastErr = err;
    }
  }
  console.warn(`[skip] ${label}: ${lastErr?.message ?? "unknown error"}`);
  return [];
}

// ---------- Concurrency-limited fan-out ----------

async function runWithLimit(jobs, limit) {
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (cursor < jobs.length) {
      const i = cursor++;
      results[i] = await jobs[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------- Build plan ----------

function buildJobs(curation) {
  const jobs = [];
  const baseParams = { order: "clickcount", reverse: "true", hidebroken: "true" };

  // Per-nation buckets.
  const perNation = curation.perNationFetchLimits ?? {};
  for (const [code, limit] of Object.entries(perNation)) {
    const params = { ...baseParams, countrycode: code.toUpperCase(), limit };
    jobs.push({ label: `country:${code} (limit ${limit})`, params });
  }

  // English-language slice — fills the "popular global English-language radio" backbone.
  const englishLimit = curation.actionFetchSizes?.userEnglishLanguage ?? 260;
  jobs.push({
    label: `language:english (limit ${englishLimit})`,
    params: { ...baseParams, language: "english", limit: englishLimit },
  });

  // Tag-driven slices — bands (AM / mediumwave), genres, niche topics.
  const tagFetches = curation.catalogTagFetches ?? {};
  for (const [tag, limit] of Object.entries(tagFetches)) {
    jobs.push({
      label: `tag:${tag} (limit ${limit})`,
      params: { ...baseParams, tag, limit },
    });
  }

  // Likely-hit name fragments — fills gaps when tags are sparse.
  const nameFragmentLimit = curation.actionFetchSizes?.perNameFragment ?? 42;
  for (const fragment of curation.catalogNameFragments ?? []) {
    jobs.push({
      label: `name:${fragment} (limit ${nameFragmentLimit})`,
      params: { ...baseParams, name: fragment, limit: nameFragmentLimit },
    });
  }

  // Brand / network needles — same list the iOS app used to fire one-request-per-needle.
  const brandNeedleLimit = curation.actionFetchSizes?.perBrandNeedle ?? 36;
  for (const needle of curation.catalogBrandNeedles ?? []) {
    jobs.push({
      label: `brand:${needle} (limit ${brandNeedleLimit})`,
      params: { ...baseParams, name: needle, limit: brandNeedleLimit },
    });
  }

  return jobs;
}

// ---------- Main ----------

async function main() {
  const t0 = Date.now();
  const curationRaw = await readFile(CURATION_PATH, "utf8");
  const curation = JSON.parse(curationRaw);
  const jobs = buildJobs(curation);
  console.log(`[plan] ${jobs.length} fetches at ${MAX_CONCURRENT}-way concurrency`);

  const thunks = jobs.map((job) => async () => fetchSlice(job.params, job.label));
  const slices = await runWithLimit(thunks, MAX_CONCURRENT);

  // Merge + dedup by stationuuid. Later slices don't overwrite earlier ones — first
  // appearance wins. Per-nation slices run before tag/needle slices, which gives
  // country-tagged metadata the strongest source of truth.
  const seen = new Set();
  const merged = [];
  for (const slice of slices) {
    if (!Array.isArray(slice)) continue;
    for (const row of slice) {
      const id = row?.stationuuid;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      // Strip fields the iOS struct doesn't decode — keeps catalog.json lean.
      const trimmed = {};
      for (const key of KEEP_FIELDS) {
        if (row[key] !== undefined) trimmed[key] = row[key];
      }
      merged.push(trimmed);
    }
  }

  // Sort by clickcount descending — gives the app a popularity-ordered list it can
  // truncate easily if it ever wants to. Stable tiebreak on name.
  merged.sort((a, b) => {
    const ca = Number(a.clickcount ?? 0);
    const cb = Number(b.clickcount ?? 0);
    if (ca !== cb) return cb - ca;
    return (a.name ?? "").localeCompare(b.name ?? "");
  });

  console.log(`[merge] ${merged.length} unique stations after dedup`);

  if (merged.length < MIN_HEALTHY_STATION_COUNT) {
    console.error(
      `[abort] only ${merged.length} stations — below MIN_HEALTHY_STATION_COUNT=${MIN_HEALTHY_STATION_COUNT}. Refusing to overwrite catalog.json.`,
    );
    process.exit(2);
  }

  // Write atomically: write to tmp then rename. Avoids leaving a half-written file
  // if the workflow gets cancelled mid-write.
  const payload = {
    schemaVersion: 1,
    builtAt: new Date().toISOString(),
    stationCount: merged.length,
    stations: merged,
  };
  const tmpPath = OUT_PATH + ".tmp";
  await writeFile(tmpPath, JSON.stringify(payload));
  const { rename } = await import("node:fs/promises");
  await rename(tmpPath, OUT_PATH);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[done] wrote ${OUT_PATH} in ${elapsed}s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
