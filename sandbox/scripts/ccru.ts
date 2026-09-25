/**
 * Read-only CLI over the CCRU graph on hijinx.world, for agent sessions.
 *
 *   node sandbox/scripts/ccru.ts status            repo snapshot vs live snapshot
 *   node sandbox/scripts/ccru.ts find <text>       label search in the snapshot
 *   node sandbox/scripts/ccru.ts item <QID>        how the graph sees one item
 *   node sandbox/scripts/ccru.ts wd <QID>          snapshot vs live Wikidata
 *
 * Add --live to read the published graph.json instead of the repo copy.
 * Imports schema.ts from the hijinx repo so the edge rules never drift.
 * Set HIJINX_REPO if the repo is not a sibling of this one.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(
  process.env.HIJINX_REPO ??
    join(HERE, "..", "..", "..", "hijinx-world-website"),
);
const REPO_JSON = join(REPO, "public/interactive/2026-ccru-graph/graph.json");
const LIVE_JSON = "https://hijinx.world/interactive/2026-ccru-graph/graph.json";
const WD_API = "https://www.wikidata.org/w/api.php";
const WDQS = "https://query.wikidata.org/sparql";
const UA =
  "WikidataForZotero-agent-scripts/0.1 (https://github.com/LizaDesya/zotero-wikidata-plugin)";

if (!existsSync(REPO_JSON)) {
  console.error(`No snapshot at ${REPO_JSON}. Set HIJINX_REPO.`);
  process.exit(1);
}
const schema = await import(
  pathToFileURL(join(REPO, "src/components/ccru-graph/schema.ts")).href
);
const { EDGE_PROPERTIES, VIA_PIDS, classifyByP31 } = schema;

type Ref = {
  url?: string;
  statedIn?: string;
  title?: string;
  quotations?: string[];
};
type Statement = {
  value: string;
  type: string;
  qualifiers?: Record<string, string[]>;
  references?: Ref[];
};
type Entity = {
  label: string;
  description?: string;
  pruned?: true;
  claims: Record<string, Statement[]>;
};
type Snapshot = {
  builtAt: string;
  crawledAt: string;
  root: string;
  scope: string[];
  counts: Record<string, number>;
  properties: Record<string, { label: string }>;
  labels: Record<string, string>;
  entities: Record<string, Entity>;
};

const [cmd, arg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const useLive = process.argv.includes("--live");

/** Retries a maxlag refusal after Retry-After, as the Wikimedia API asks. */
async function getJson(url: string, tries = 4): Promise<any> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Api-User-Agent": UA },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const body = await res.json();
  if (body.error?.code === "maxlag" && tries > 1) {
    const wait = Number(res.headers.get("retry-after") ?? 5);
    console.error(`(Wikidata lagged, retrying in ${wait}s)`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return getJson(url, tries - 1);
  }
  if (body.error) throw new Error(`${body.error.code}: ${body.error.info}`);
  return body;
}

const loadRepo = (): Snapshot => JSON.parse(readFileSync(REPO_JSON, "utf8"));
const loadLive = async (): Promise<Snapshot> => getJson(LIVE_JSON);
const load = () => (useLive ? loadLive() : Promise.resolve(loadRepo()));

function labeller(s: Snapshot) {
  return (qid: string) =>
    `${s.entities[qid]?.label ?? s.labels[qid] ?? "?"} (${qid})`;
}

function coreSet(s: Snapshot): Set<string> {
  const core = new Set([s.root]);
  for (const qid of s.scope) {
    for (const pid of ["P463", "P1416"]) {
      for (const st of s.entities[qid]?.claims[pid] ?? []) {
        if (st.type === "q" && st.value === s.root) core.add(qid);
      }
    }
  }
  return core;
}

type Edge = {
  pid: string;
  label: string;
  tag: string;
  enabled: boolean;
  from: string;
  to: string;
  statedOn: string;
  via?: string;
  refs: Ref[];
};

/** Mirrors buildGraph's emit loop in build-graph.ts, keeping disabled properties. */
function edges(s: Snapshot): Edge[] {
  const scope = new Set(s.scope);
  const core = coreSet(s);
  const out: Edge[] = [];
  const emit = (
    cfg: any,
    subject: string,
    st: Statement,
    bridge: string | null,
  ) => {
    if (st.type !== "q" || !s.entities[st.value]) return;
    const [from, to] = cfg.invert ? [st.value, subject] : [subject, st.value];
    if (from === to) return;
    out.push({
      pid: cfg.pid,
      label: cfg.edgeLabel ?? cfg.property,
      tag: cfg.tag,
      enabled: cfg.enabled,
      from,
      to,
      statedOn: bridge ?? subject,
      via: bridge ?? undefined,
      refs: st.references ?? [],
    });
  };
  for (const cfg of EDGE_PROPERTIES) {
    for (const qid of scope) {
      if (cfg.coreOnly && !core.has(qid)) continue;
      const e = s.entities[qid];
      if (!e) continue;
      for (const st of e.claims[cfg.pid] ?? []) emit(cfg, qid, st, null);
      if (!cfg.via) continue;
      for (const b of e.claims[cfg.via.pid] ?? []) {
        const bridge = s.entities[b.value];
        if (b.type !== "q" || !bridge) continue;
        for (const st of bridge.claims[cfg.pid] ?? [])
          emit(cfg, qid, st, b.value);
      }
    }
  }
  return out;
}

function fmtRefs(s: Snapshot, refs: Ref[], indent = "      ") {
  const name = labeller(s);
  if (!refs.length) return `${indent}(no references)`;
  return refs
    .map((r) => {
      const bits = [
        r.statedIn && `stated in ${name(r.statedIn)}`,
        r.title && `"${r.title}"`,
        r.url,
      ].filter(Boolean);
      const q = (r.quotations ?? []).map(
        (t) => `\n${indent}  > ${t.length > 160 ? t.slice(0, 160) + "…" : t}`,
      );
      return `${indent}- ${bits.join(" · ") || "{}"}${q.join("")}`;
    })
    .join("\n");
}

async function status() {
  const repo = loadRepo();
  const live = await loadLive();
  const hours = (iso: string) =>
    ((Date.now() - Date.parse(iso)) / 36e5).toFixed(1) + "h ago";
  for (const [name, s] of [
    ["repo", repo],
    ["live", live],
  ] as const) {
    console.log(
      `${name}: built ${s.builtAt} (${hours(s.builtAt)}), crawled ${s.crawledAt}, ` +
        `${s.counts.entities} entities, ${s.counts.statements} statements, ` +
        `${s.counts.references} references, scope ${s.scope.length}`,
    );
  }
  const diff = (a: Snapshot, b: Snapshot) =>
    Object.keys(a.entities).filter((q) => !b.entities[q]);
  const scopeDiff = (a: Snapshot, b: Snapshot) =>
    a.scope.filter((q) => !b.scope.includes(q));
  const rows: Array<[string, string[], Snapshot]> = [
    ["cached only in repo", diff(repo, live), repo],
    ["cached only in live", diff(live, repo), live],
    ["in scope only in repo", scopeDiff(repo, live), repo],
    ["in scope only in live", scopeDiff(live, repo), live],
  ];
  for (const [title, qids, s] of rows) {
    if (qids.length)
      console.log(`${title}: ${qids.map(labeller(s)).join(", ")}`);
  }
  // Statement-level drift on items both copies hold.
  const changed = Object.keys(repo.entities).filter(
    (q) =>
      live.entities[q] &&
      JSON.stringify(repo.entities[q].claims) !==
        JSON.stringify(live.entities[q].claims),
  );
  if (changed.length)
    console.log(`claims differ: ${changed.map(labeller(repo)).join(", ")}`);
  if (!rows.some(([, q]) => q.length) && !changed.length)
    console.log("repo and live hold the same entities, scope and claims.");
}

async function find(text: string) {
  const s = await load();
  const needle = text.toLowerCase();
  const scope = new Set(s.scope);
  for (const [qid, e] of Object.entries(s.entities)) {
    if (!e.label.toLowerCase().includes(needle)) continue;
    const where = scope.has(qid) ? "scope" : e.pruned ? "pruned" : "cached";
    console.log(`${qid}\t${where}\t${e.label}\t${e.description ?? ""}`);
  }
  for (const [qid, l] of Object.entries(s.labels)) {
    if (!s.entities[qid] && l.toLowerCase().includes(needle))
      console.log(`${qid}\tlabel-only\t${l}`);
  }
}

async function item(qid: string) {
  const s = await load();
  const name = labeller(s);
  const e = s.entities[qid];
  const scope = new Set(s.scope);
  const core = coreSet(s);
  console.log(name(qid));
  if (!e) {
    console.log(
      s.labels[qid]
        ? "  not cached: a statement names it, but the crawl stopped short, so it draws nothing"
        : "  not in the snapshot at all",
    );
  } else {
    const p31 = (e.claims.P31 ?? []).map((x) => x.value);
    console.log(`  ${e.description ?? ""}`);
    console.log(
      `  class ${classifyByP31(p31)} (P31: ${p31.map(name).join(", ") || "none"})`,
    );
    console.log(
      `  ${scope.has(qid) ? "in scope, emits edges" : "cached, NOT in scope: its own statements draw nothing"}` +
        `${core.has(qid) ? "; core (root or tier-1 roster)" : ""}${e.pruned ? "; claims pruned by crawl" : ""}`,
    );
  }
  const mine = edges(s).filter((x) => x.from === qid || x.to === qid);
  console.log(
    `\nEdges (${mine.filter((x) => x.enabled).length} drawn by default):`,
  );
  for (const x of mine) {
    const other = x.from === qid ? `→ ${name(x.to)}` : `← ${name(x.from)}`;
    const off = x.enabled ? "" : " [toggle off by default]";
    const via = x.via ? ` via ${name(x.via)}` : "";
    console.log(`  ${x.pid} ${x.label} ${other} [${x.tag}]${via}${off}`);
    console.log(fmtRefs(s, x.refs));
  }
  // Statements in scope that point at this item but cannot draw, and why.
  const edgePids = new Set(EDGE_PROPERTIES.map((c: any) => c.pid));
  const blocked: string[] = [];
  for (const [subj, se] of Object.entries(s.entities)) {
    for (const [pid, sts] of Object.entries(se.claims)) {
      if (!edgePids.has(pid)) continue;
      for (const st of sts) {
        if (st.value !== qid || subj === qid) continue;
        if (mine.some((x) => x.pid === pid && x.statedOn === subj)) continue;
        const cfg = EDGE_PROPERTIES.find((c: any) => c.pid === pid);
        const why = !scope.has(subj)
          ? "subject not in scope"
          : cfg.coreOnly && !core.has(subj)
            ? "coreOnly property, subject not core"
            : !e
              ? "this item is not cached"
              : "unknown";
        blocked.push(`  ${pid} on ${name(subj)}: ${why}`);
      }
    }
  }
  if (blocked.length) console.log(`\nNot drawn:\n${blocked.join("\n")}`);
}

async function wd(qid: string) {
  const s = await load();
  const name = labeller(s);
  const e = s.entities[qid];
  const pids = [
    "P31",
    ...new Set([...EDGE_PROPERTIES.map((c: any) => c.pid), ...VIA_PIDS]),
  ];
  const data = await getJson(
    `${WD_API}?action=wbgetentities&ids=${qid}&props=labels|claims&languages=en&format=json`,
  );
  const live = data.entities?.[qid];
  if (!live || live.missing !== undefined) {
    console.log(`${qid} does not exist on Wikidata.`);
    return;
  }
  console.log(
    `${live.labels?.en?.value ?? qid} (${qid}), outgoing statements:`,
  );
  for (const pid of pids) {
    const wdSts = (live.claims[pid] ?? []).filter(
      (c: any) => c.rank !== "deprecated",
    );
    const snap = e?.claims[pid] ?? [];
    const vals = new Set<string>([
      ...wdSts.map((c: any) => c.mainsnak.datavalue?.value?.id ?? "?"),
      ...snap.map((x) => x.value),
    ]);
    for (const v of vals) {
      const w = wdSts.find((c: any) => c.mainsnak.datavalue?.value?.id === v);
      const sn = snap.find((x) => x.value === v);
      const state = !sn
        ? "NEW on Wikidata, not in snapshot"
        : !w
          ? "GONE from Wikidata, still in snapshot"
          : (w.references?.length ?? 0) !== (sn.references?.length ?? 0)
            ? `refs changed: Wikidata ${w.references?.length ?? 0}, snapshot ${sn.references?.length ?? 0}`
            : `ok, ${sn.references?.length ?? 0} refs`;
      console.log(
        `  ${pid} ${s.properties[pid]?.label ?? ""} → ${name(v)}: ${state}`,
      );
    }
  }
  // Incoming statements only show up through SPARQL.
  const values = EDGE_PROPERTIES.map((c: any) => `wdt:${c.pid}`).join(" ");
  const q = `SELECT ?s ?p WHERE { VALUES ?p { ${values} } ?s ?p wd:${qid} }`;
  const res = await getJson(
    `${WDQS}?format=json&query=${encodeURIComponent(q)}`,
  );
  const scope = new Set(s.scope);
  const rows = res.results.bindings;
  console.log(`\nIncoming edge statements on Wikidata (${rows.length}):`);
  for (const r of rows) {
    const subj = r.s.value.split("/").pop();
    const pid = r.p.value.split("/").pop();
    const inSnap = s.entities[subj]?.claims[pid]?.some((x) => x.value === qid);
    const state = !scope.has(subj)
      ? "subject not in scope"
      : inSnap
        ? "in snapshot"
        : "NEW, not in snapshot";
    console.log(`  ${name(subj)} ${pid} → ${qid}: ${state}`);
  }
  console.log(
    `\nSnapshot crawled ${s.crawledAt}. NEW or GONE rows clear after pnpm ccru:crawl --refresh.`,
  );
}

const commands: Record<string, (a: string) => Promise<void>> = {
  status,
  find,
  item,
  wd,
};
const run = commands[cmd ?? ""];
if (!run || (cmd !== "status" && !arg)) {
  console.log(
    readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0],
  );
  process.exit(1);
}
await run(arg);
