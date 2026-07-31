#!/usr/bin/env node
// Liveness probe for catalog stations.
//
// A station only ships if its stream actually answers. radio-browser's own
// hidebroken flag lags reality (their checker runs infrequently and misses
// geo-blocks / recently-died streams), so we verify first-party at build time.
//
// Verdicts:
//   live — HTTP < 400 answered within the timeout (headers are enough; we
//          abort before reading the body so icecast streams don't hang us)
//   dead — DNS/TCP failure, timeout, or HTTP >= 400 on BOTH probe passes
//
// Curated stations (pinned / featured / remapped / cold-start / default
// favorites in curation.json) are never dropped — they're reported instead,
// so a dead hand-picked stream is a curation decision, not a silent removal.
//
// Standalone usage (filter an existing catalog in place):
//   node probe-live.mjs [--catalog catalog.json] [--curation curation.json] \
//                       [--report dead-stations-report.json]

import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROBE_TIMEOUT_MS = 12_000;
const PROBE_CONCURRENCY = 32;
const USER_AGENT =
  "WorldRadioDial-Aggregator/1.0 (+https://github.com/markkaminsky/worldradiodial)";

/** Probe one stream URL. Resolves to { ok, detail }. */
async function probeOnce(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT, Range: "bytes=0-1023" },
      redirect: "follow",
      signal: controller.signal,
    });
    // Headers arrived — that's proof of life. Kill the body read immediately
    // so endless icecast streams don't tie up the slot.
    controller.abort();
    if (res.status >= 400) return { ok: false, detail: `HTTP ${res.status}` };
    return { ok: true, detail: `HTTP ${res.status}` };
  } catch (err) {
    // AbortError after headers already returned above; an abort here means timeout.
    const name = err?.name === "AbortError" ? "timeout" : (err?.cause?.code ?? err?.message ?? "error");
    const code = String(name);
    // Only verdicts that prove nothing is listening count as dead. Everything
    // else — ICY "200 OK" replies (HPE_INVALID_CONSTANT), servers that push
    // audio without clean HTTP (UND_ERR_SOCKET), TLS cert quirks — is a live
    // server that fetch() can't parse but a media player handles fine.
    const DEAD_CODES = new Set([
      "timeout",
      "UND_ERR_CONNECT_TIMEOUT",
      "ENOTFOUND",
      "EAI_AGAIN",
      "ENETUNREACH",
      "EHOSTUNREACH",
      "ECONNREFUSED",
    ]);
    return { ok: !DEAD_CODES.has(code), detail: code };
  } finally {
    clearTimeout(timer);
  }
}

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

/** Names curation has hand-picked; these are never auto-dropped. */
export function protectedNames(curation) {
  const names = new Set();
  const add = (v) => {
    if (typeof v === "string") names.add(v.toLowerCase());
    else if (Array.isArray(v)) v.forEach(add);
    else if (v && typeof v === "object") Object.values(v).forEach(add);
  };
  add(curation.pinnedStations);
  add(curation.featuredByTag);
  add(curation.stationCategoryRemappings);
  add(curation.coldStartPool);
  add(curation.defaultFavoriteNames);
  return names;
}

/**
 * Probe every station; returns { kept, dropped } where dropped rows carry
 * { name, countrycode, clickcount, url, reason }. Two passes: anything that
 * fails round one gets one retry so transient blips don't kill live stations.
 */
export async function probeStations(stations, curation, log = console.log) {
  const protectedSet = protectedNames(curation);
  const t0 = Date.now();

  const urlOf = (s) => s.url_resolved || s.url || "";
  const firstPass = await runWithLimit(
    stations.map((s) => async () => probeOnce(urlOf(s))),
    PROBE_CONCURRENCY,
  );

  const retryIdx = [];
  firstPass.forEach((r, i) => { if (!r.ok) retryIdx.push(i); });
  log(`[probe] pass 1: ${stations.length - retryIdx.length}/${stations.length} live; retrying ${retryIdx.length}`);

  const secondPass = await runWithLimit(
    retryIdx.map((i) => async () => probeOnce(urlOf(stations[i]))),
    PROBE_CONCURRENCY,
  );
  retryIdx.forEach((i, k) => { if (secondPass[k].ok) firstPass[i] = secondPass[k]; });

  const kept = [];
  const dropped = [];
  stations.forEach((s, i) => {
    const r = firstPass[i];
    const isProtected = protectedSet.has((s.name ?? "").trim().toLowerCase());
    if (r.ok || isProtected) {
      kept.push(s);
      if (!r.ok) log(`[probe] KEEPING dead-but-curated: ${s.name} (${r.detail})`);
    } else {
      dropped.push({
        name: s.name,
        countrycode: s.countrycode,
        clickcount: s.clickcount,
        url: urlOf(s),
        reason: r.detail,
      });
    }
  });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  log(`[probe] done in ${elapsed}s: ${kept.length} live, ${dropped.length} dead`);
  return { kept, dropped };
}

// ---------- Standalone CLI ----------

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((acc, cur, i, arr) => {
      if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1]]);
      return acc;
    }, []),
  );
  const catalogPath = resolve(__dirname, args.catalog ?? "catalog.json");
  const curationPath = resolve(__dirname, args.curation ?? "curation.json");
  const reportPath = resolve(__dirname, args.report ?? "dead-stations-report.json");

  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const curation = JSON.parse(await readFile(curationPath, "utf8"));
  const { kept, dropped } = await probeStations(catalog.stations, curation);

  catalog.stations = kept;
  catalog.stationCount = kept.length;
  const tmp = catalogPath + ".tmp";
  await writeFile(tmp, JSON.stringify(catalog));
  await rename(tmp, catalogPath);
  await writeFile(reportPath, JSON.stringify({ probedAt: catalog.builtAt, dropped }, null, 2));
  console.log(`[done] ${catalogPath} now ${kept.length} stations; ${dropped.length} dead listed in ${reportPath}`);
}
