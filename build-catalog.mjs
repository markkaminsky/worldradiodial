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

// Optional: also write the shaped catalog to the iOS app bundle so the bundled baseline
// never drifts from the CDN. Pass the app's catalog-baseline.json path, e.g.:
//   node build-catalog.mjs --baseline-out ../WorldRadioDial/iOS/WorldRadioDial/WorldRadioDial/Resources/catalog-baseline.json
const BASELINE_OUT = args["baseline-out"] ? resolve(process.cwd(), args["baseline-out"]) : null;

// Audit log of what the shape dropped — always written next to catalog.json, never shipped
// to the app. Look here if a station you expected goes missing.
const REPORT_PATH = resolve(__dirname, args["report-out"] ?? "shape-report.json");

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

// ---------- Shape to dial ----------
//
// A raw merge is ~4–12k stations, but the dial can only SHOW a bounded number
// (≈20 per FM/AM frequency, ≤30 WEB genre slots × 20). ~75% of the merge is WEB
// long-tail that never reaches the dial and only pads search — and search / Local /
// category deep-dive are already live-fetched in the app. This trims the emitted
// catalog down to what the dial surfaces (~1,200 stations): keep US broadcast + the
// curator's explicit choices + genuinely popular stations, then hard-cap the tail
// per FM frequency and per WEB genre.
//
// Keep this in sync with the iOS app: the band parse mirrors classifyBand in
// AssignFrequencies.swift, and the SAME shaped set must ship as the app's bundled
// catalog-baseline.json — otherwise the app's change-detection gate sees "changed"
// on every launch and re-applies the full set (re-bloat + a visible second update).

const SHAPE = {
  keepNetworks: ["exclusively", "virgin radio rockstar"], // curated artist-station networks
  keepCountries: new Set(["AE"]),                          // Dubai
  fmSlotCap: 6,        // non-protected FM kept per frequency
  webGenreCap: 12,     // non-protected WEB kept per genre
  webOtherCap: 6,      // … and in the "other" bucket
  fmMinForeignClicks: 10,
  topGenres: 30,
  // "Popular" = a blended score (votes + clicks×100), kept regardless of genre crowding.
  // Radio Browser clickcount is sparse — national broadcasters like talkSPORT or RMF FM
  // sit at ~40 clicks but tens of thousands of votes — while votes alone are too loose
  // (cumulative/inflated). ≥10,000 ≈ "votes in the ten-thousands, or clicks ≥100": the
  // recognizable-broadcaster tier (~230 stations).
  popularScore: 10000,
};

function shapeToDialCatalog(stations, curation) {
  const cco = (s) => Number(s.clickcount ?? 0);
  const pop = (s) => Number(s.votes ?? 0) + cco(s) * 100; // blended popularity (votes-aware)
  const US = (s) => (s.countrycode || "").toUpperCase() === "US";
  const DXB = (s) => SHAPE.keepCountries.has((s.countrycode || "").toUpperCase());

  // substring for long terms, word-boundary for short ones (so "wor" doesn't match "network")
  const makeMatcher = (terms) => {
    const t = (terms || []).filter((x) => x && x.length >= 3).map((x) => x.toLowerCase());
    const longs = t.filter((x) => x.length >= 5);
    const shorts = t.filter((x) => x.length < 5)
      .map((x) => new RegExp(`\\b${x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`));
    return (name) => {
      const nm = (name || "").toLowerCase();
      return longs.some((x) => nm.includes(x)) || shorts.some((r) => r.test(nm));
    };
  };
  const isPick = makeMatcher([
    ...(curation.pinnedStations || []).map((p) => p.callSign || ""),
    ...(curation.defaultFavoriteNames || []),
    ...Object.values(curation.featuredByTag || {}).flat(),
    ...SHAPE.keepNetworks,
  ]);
  const isBrand = makeMatcher(curation.catalogBrandNeedles || []);

  // band parse — mirror of classifyBand in AssignFrequencies.swift
  const fmFreq = (name) => {
    const m = /(\d{2,3}\.\d)\s*(FM|MHz)/i.exec(name);
    if (m && +m[1] >= 88 && +m[1] <= 108) return +m[1];
    for (const x of String(name).matchAll(/(?<![0-9.])(\d{2,3}\.\d)(?![0-9])/g))
      if (+x[1] >= 88 && +x[1] <= 108) return +x[1];
    return null;
  };
  const isAM = (name) =>
    [/\bAM\s*-?\s*(\d{3,4})\b/i, /\b(\d{3,4})\s*AM\b/i, /\b(\d{3,4})\s*kHz\b/i].some((re) => {
      const m = re.exec(name);
      return m && +m[1] >= 530 && +m[1] <= 1700;
    });
  const band = (s) => (isAM(s.name) ? "AM" : fmFreq(s.name) != null ? "FM" : "WEB");
  const ptag = (s) =>
    (s.tags || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)[0] || "other";

  // Always keep: the curator's picks, US broadcast, Dubai, and any genuinely popular station
  // (blended votes+clicks score) — the last one stops the genre cap from dropping global
  // flagships like talkSPORT, RFI, RMF FM that have huge votes but a handful of clicks.
  const keepProtected = (s) => isPick(s.name) || US(s) || DXB(s) || pop(s) >= SHAPE.popularScore;
  // Fill remaining slots brand-first, then by blended popularity (so the tail keeps the
  // better-known stations, not whichever happened to log a few more clicks).
  const qcmp = (a, b) => (isBrand(a.name) ? 0 : 1) - (isBrand(b.name) ? 0 : 1) || pop(b) - pop(a);

  const out = [], fm = [], am = [], web = [];
  for (const s of stations) (band(s) === "AM" ? am : band(s) === "FM" ? fm : web).push(s);

  const fmSlots = {};
  for (const s of fm) {
    if (keepProtected(s)) out.push(s);
    else if (cco(s) >= SHAPE.fmMinForeignClicks) (fmSlots[fmFreq(s.name)] ||= []).push(s);
  }
  for (const f in fmSlots) out.push(...fmSlots[f].sort(qcmp).slice(0, SHAPE.fmSlotCap));

  out.push(...am); // AM is small — keep all

  const counts = {};
  for (const s of web) counts[ptag(s)] = (counts[ptag(s)] || 0) + 1;
  const topGenres = new Set(
    Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, SHAPE.topGenres).map((e) => e[0]),
  );
  const buckets = {};
  for (const s of web) {
    if (keepProtected(s)) { out.push(s); continue; }
    (buckets[topGenres.has(ptag(s)) ? ptag(s) : "other"] ||= []).push(s);
  }
  for (const g in buckets)
    out.push(...buckets[g].sort(qcmp).slice(0, g === "other" ? SHAPE.webOtherCap : SHAPE.webGenreCap));

  // Audit: everything the shape dropped, so no curation is silently lost — written to a
  // separate report file the build doesn't ship, for review if a good station goes missing.
  const keptIds = new Set(out.map((s) => s.stationuuid));
  const dropped = stations.filter((s) => !keptIds.has(s.stationuuid));
  const byBand = {};
  for (const s of stations) {
    const bnd = band(s);
    (byBand[bnd] ||= { kept: 0, dropped: 0 })[keptIds.has(s.stationuuid) ? "kept" : "dropped"]++;
  }
  const droppedByGenre = {};
  for (const s of dropped) droppedByGenre[ptag(s)] = (droppedByGenre[ptag(s)] || 0) + 1;

  return {
    kept: out,
    report: {
      rawCount: stations.length,
      keptCount: out.length,
      droppedCount: dropped.length,
      byBand,
      droppedByGenre: Object.fromEntries(Object.entries(droppedByGenre).sort((a, b) => b[1] - a[1])),
      // Full list so a missing favourite can be found by name; trimmed to the fields that
      // make a station identifiable (this file is for humans, not the app).
      dropped: dropped
        .map((s) => ({
          stationuuid: s.stationuuid,
          name: s.name,
          countrycode: s.countrycode,
          clickcount: s.clickcount ?? 0,
          tags: s.tags,
        }))
        .sort((a, b) => (b.clickcount ?? 0) - (a.clickcount ?? 0)),
    },
  };
}

// Floor for the *shaped* catalog — protects against a curation/parse bug that nukes
// the catalog to near-nothing. Well below the expected ~1,200.
const MIN_SHAPED_STATION_COUNT = 600;

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

  // Health check runs on the RAW merge — it guards against the API having a bad day,
  // which must happen before we shape (the shaped count is intentionally ~1,200).
  if (merged.length < MIN_HEALTHY_STATION_COUNT) {
    console.error(
      `[abort] only ${merged.length} stations — below MIN_HEALTHY_STATION_COUNT=${MIN_HEALTHY_STATION_COUNT}. Refusing to overwrite catalog.json.`,
    );
    process.exit(2);
  }

  // Shape the raw merge down to what the dial can actually surface.
  const { kept: shaped, report } = shapeToDialCatalog(merged, curation);
  console.log(`[shape] ${merged.length} -> ${shaped.length} stations (dial-capacity trim)`);
  if (shaped.length < MIN_SHAPED_STATION_COUNT) {
    console.error(
      `[abort] shaped to only ${shaped.length} stations — below MIN_SHAPED_STATION_COUNT=${MIN_SHAPED_STATION_COUNT}. Likely a curation/parse bug; refusing to overwrite.`,
    );
    process.exit(2);
  }

  const builtAt = new Date().toISOString();
  const payload = { schemaVersion: 1, builtAt, stationCount: shaped.length, stations: shaped };

  // Write atomically: tmp then rename. Avoids leaving a half-written file if cancelled mid-write.
  const { rename } = await import("node:fs/promises");
  const writeAtomic = async (path, data) => {
    const tmp = path + ".tmp";
    await writeFile(tmp, data);
    await rename(tmp, path);
  };

  const catalogJson = JSON.stringify(payload);
  await writeAtomic(OUT_PATH, catalogJson);
  console.log(`[write] ${OUT_PATH} (${shaped.length} stations)`);

  // Mirror the EXACT shaped catalog into the iOS app bundle so the bundled baseline and the
  // CDN can't drift — keeps the app's change-detection gate silent because they match byte-for-byte.
  if (BASELINE_OUT) {
    await writeAtomic(BASELINE_OUT, catalogJson);
    console.log(`[write] ${BASELINE_OUT} (iOS baseline — identical to CDN)`);
  }

  // Audit log of everything dropped, for human review — never shipped to the app.
  await writeAtomic(REPORT_PATH, JSON.stringify({ builtAt, ...report }, null, 2));
  console.log(
    `[report] ${REPORT_PATH}: dropped ${report.droppedCount} ` +
      `(FM ${report.byBand.FM?.dropped ?? 0} / AM ${report.byBand.AM?.dropped ?? 0} / WEB ${report.byBand.WEB?.dropped ?? 0})`,
  );

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[done] in ${elapsed}s`);
}

// Only run the full build when invoked directly — lets tests import shapeToDialCatalog
// without triggering the live fetch.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { shapeToDialCatalog };
