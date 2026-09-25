/**
 * Shared helpers for the sandbox scripts: the CCRU snapshot, its schema,
 * Wikidata reads and text normalising. Imported by ccru.ts and qs.ts.
 *
 * Set HIJINX_REPO if the hijinx repo is not a sibling of this one.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(
  process.env.HIJINX_REPO ??
    join(HERE, "..", "..", "..", "hijinx-world-website"),
);
export const REPO_JSON = join(
  REPO,
  "public/interactive/2026-ccru-graph/graph.json",
);
export const LIVE_JSON =
  "https://hijinx.world/interactive/2026-ccru-graph/graph.json";
export const WD_API = "https://www.wikidata.org/w/api.php";
export const WDQS = "https://query.wikidata.org/sparql";
export const UA =
  "WikidataForZotero-agent-scripts/0.1 (https://github.com/LizaDesya/zotero-wikidata-plugin)";

if (!existsSync(REPO_JSON)) {
  console.error(`No snapshot at ${REPO_JSON}. Set HIJINX_REPO.`);
  process.exit(1);
}
export const schema = await import(
  pathToFileURL(join(REPO, "src/components/ccru-graph/schema.ts")).href
);

export type Ref = {
  url?: string;
  statedIn?: string;
  title?: string;
  quotations?: string[];
};
export type Statement = {
  value: string;
  type: string;
  qualifiers?: Record<string, string[]>;
  references?: Ref[];
};
export type Entity = {
  label: string;
  description?: string;
  pruned?: true;
  claims: Record<string, Statement[]>;
};
export type Snapshot = {
  builtAt: string;
  crawledAt: string;
  root: string;
  scope: string[];
  counts: Record<string, number>;
  properties: Record<string, { label: string }>;
  labels: Record<string, string>;
  entities: Record<string, Entity>;
};

/** Retries a maxlag refusal after Retry-After, as the Wikimedia API asks. */
export async function getJson(url: string, tries = 4): Promise<any> {
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

/** wbgetentities in batches of 50. Missing ids come back with `missing`. */
export async function getEntities(
  ids: string[],
  props = "info|datatype|labels",
): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50);
    let data: any;
    // One unknown id fails the whole request: note it as missing and retry.
    while (batch.length) {
      try {
        data = await getJson(
          `${WD_API}?action=wbgetentities&ids=${batch.join("|")}&props=${props}&languages=en&format=json`,
        );
        break;
      } catch (e: any) {
        const id = /no-such-entity: .*"(\w+)"/.exec(e.message)?.[1];
        if (!id || !batch.includes(id)) throw e;
        out[id] = { id, missing: "" };
        batch.splice(batch.indexOf(id), 1);
      }
    }
    if (!data) continue;
    for (const [id, e] of Object.entries<any>(data.entities ?? {})) {
      out[id] = e;
      // A redirected id comes back under its target. Keep the asked-for key.
      if (e.redirects) out[e.redirects.from] = e;
    }
  }
  return out;
}

export const loadRepo = (): Snapshot =>
  JSON.parse(readFileSync(REPO_JSON, "utf8"));
export const loadLive = async (): Promise<Snapshot> => getJson(LIVE_JSON);

export function labeller(s: Snapshot) {
  return (qid: string) =>
    `${s.entities[qid]?.label ?? s.labels[qid] ?? "?"} (${qid})`;
}

export function coreSet(s: Snapshot): Set<string> {
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

/** Zotero text and Wikidata text disagree on quote marks and spacing. */
export const normText = (t: string) =>
  t
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

/** Scheme, www., trailing slash and fragment don't make a different source. */
export const normUrl = (u: string) =>
  u
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/#.*$/, "")
    .replace(/\/+$/, "");

export type Citation = {
  subject: string;
  pid: string;
  statement: Statement;
  refs: Array<{ ref: Ref; hits: string[] }>;
};

/** Every snapshot statement whose references cite a quote, URL or source QID. */
export function findCitations(s: Snapshot, query: string): Citation[] {
  const isQid = /^Q\d+$/i.test(query);
  const isUrl = /^(https?:\/\/|www\.)/i.test(query);
  const needle = isUrl ? normUrl(query) : normText(query);
  const matchRef = (r: Ref): string[] => {
    if (isQid) return r.statedIn === query.toUpperCase() ? ["stated in"] : [];
    if (isUrl) return r.url && normUrl(r.url).includes(needle) ? ["url"] : [];
    const hits: string[] = [];
    if (r.url && normUrl(r.url).includes(needle)) hits.push("url");
    if (r.title && normText(r.title).includes(needle)) hits.push("title");
    if (r.quotations?.some((q) => normText(q).includes(needle)))
      hits.push("quotation");
    return hits;
  };
  const out: Citation[] = [];
  for (const [subject, e] of Object.entries(s.entities)) {
    for (const [pid, sts] of Object.entries(e.claims)) {
      for (const statement of sts) {
        const refs = (statement.references ?? [])
          .map((ref) => ({ ref, hits: matchRef(ref) }))
          .filter((x) => x.hits.length);
        if (refs.length) out.push({ subject, pid, statement, refs });
      }
    }
  }
  return out;
}
