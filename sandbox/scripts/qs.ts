/**
 * QuickStatements drafter with batch tracking, for agent sessions.
 *
 *   node sandbox/scripts/qs.ts draft <input.json>       write sandbox/statements/<date>-<slug>.md
 *   node sandbox/scripts/qs.ts check <batch.md> [n]     warnings per line, before running
 *   node sandbox/scripts/qs.ts verify <batch.md> [n]    compare with live Wikidata, update status
 *   node sandbox/scripts/qs.ts next <batch.md>          progress and the first unfinished chunk
 *   node sandbox/scripts/qs.ts mark <batch.md> <n> <status> [note]
 *
 * Never writes to Wikidata: the user pastes each chunk into QuickStatements.
 * The input format and the batch file are described in
 * sandbox/docs/prototyping.md. Add --force to let draft overwrite a batch.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  coreSet,
  findCitations,
  getEntities,
  labeller,
  loadRepo,
  normText,
  normUrl,
  schema,
  type Snapshot,
} from "./lib.ts";

const { EDGE_PROPERTIES } = schema;
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "statements");
/** Wikibase `string-limits` on Wikidata (wmf-config), for strings, urls and monolingual text. */
const MAX_TEXT = 1500;
const STATUSES = [
  "pending",
  "run",
  "verified",
  "revised",
  "skipped",
  "done-manually",
];
const FINISHED = new Set(["verified", "skipped", "done-manually"]);
const today = () => new Date().toLocaleDateString("sv");
const now = () => new Date().toISOString().slice(0, 16).replace("T", " ");

// --- input -----------------------------------------------------------------

type Source = {
  url?: string;
  statedIn?: string;
  retrieved?: string;
  title?: string;
  quote?: string | string[];
  lang?: string;
};
type Intent = {
  chunk?: string;
  subject: string;
  property: string;
  value: string;
  qualifiers?: Record<string, string | string[]>;
  source?: Source;
  sources?: Source[];
  lang?: string;
  zotero?: { item?: string; attachment?: string; annotation?: string };
  note?: string;
};
type Input = {
  goal: string;
  slug?: string;
  collection?: string;
  retrieved?: string;
  lang?: string;
  statements: Intent[];
};

// --- QS values -------------------------------------------------------------

type Val =
  | { kind: "item"; id: string }
  | { kind: "string"; text: string }
  | { kind: "mono"; lang: string; text: string }
  | { kind: "time"; time: string; precision: number }
  | { kind: "quantity"; amount: number }
  | { kind: "special"; v: string }
  | { kind: "bad"; raw: string };
type Snak = { pid: string; val: Val };
type Line = {
  raw: string;
  subject: string;
  pid: string;
  val: Val;
  qualifiers: Snak[];
  refs: Snak[][];
  errors: string[];
};

/** What each datatype's value looks like once parsed. */
const KIND: Record<string, Val["kind"]> = {
  "wikibase-item": "item",
  time: "time",
  monolingualtext: "mono",
  string: "string",
  "external-id": "string",
  url: "string",
  commonsMedia: "string",
  quantity: "quantity",
};

/**
 * Mirrors parse_value in QS 3.0 (core/parsers/base.py) and parseValueV1 in
 * QS 2: both match `^"(.*)"$` greedily, so inner straight quotes survive.
 */
function parseValue(v: string): Val {
  v = v.trim();
  if (v === "somevalue" || v === "novalue") return { kind: "special", v };
  if (/^Q\d+$/i.test(v)) return { kind: "item", id: v.toUpperCase() };
  let m = /^([a-z_-]+):"(.*)"$/is.exec(v);
  if (m) return { kind: "mono", lang: m[1], text: m[2].trim() };
  m = /^"(.*)"$/s.exec(v);
  if (m) return { kind: "string", text: m[1].trim() };
  m = /^([+-]\d+-\d\d-\d\dT00:00:00Z)(?:\/(\d+))?$/.exec(v);
  if (m) return { kind: "time", time: m[1], precision: Number(m[2] ?? 9) };
  if (/^[+-]?\d+(\.\d+)?$/.test(v))
    return { kind: "quantity", amount: Number(v) };
  return { kind: "bad", raw: v };
}

/** A QS v1 statement line: subject, property, value, then key/value pairs. */
function parseLine(raw: string): Line {
  // QS 3.0 drops empty columns, so a doubled tab is harmless.
  const cols = raw.split("\t").filter((c) => c.trim());
  const line: Line = {
    raw,
    subject: (cols[0] ?? "").trim().toUpperCase(),
    pid: (cols[1] ?? "").trim().toUpperCase(),
    val: parseValue(cols[2] ?? ""),
    qualifiers: [],
    refs: [],
    errors: [],
  };
  if (cols.length < 3) {
    line.errors.push(
      "needs subject, property and value separated by tabs (did the editor turn tabs into spaces?)",
    );
    return line;
  }
  if (!/^Q\d+$/.test(line.subject))
    line.errors.push(`subject ${line.subject} is not a QID`);
  if (!/^P\d+$/.test(line.pid))
    line.errors.push(`property ${line.pid} is not a PID`);
  if ((cols.length - 3) % 2)
    line.errors.push("odd number of qualifier/reference columns");
  for (let i = 3; i + 1 < cols.length; i += 2) {
    const key = cols[i].trim().toUpperCase();
    const val = parseValue(cols[i + 1]);
    if (/^P\d+$/.test(key)) line.qualifiers.push({ pid: key, val });
    else if (/^!?S\d+$/.test(key)) {
      if (key.startsWith("!") || !line.refs.length) line.refs.push([]);
      line.refs.at(-1)!.push({ pid: key.replace(/^!?S/, "P"), val });
    } else line.errors.push(`unknown column ${key}`);
  }
  return line;
}

const snaks = (l: Line): Snak[] => [
  { pid: l.pid, val: l.val },
  ...l.qualifiers,
  ...l.refs.flat(),
];

function qsTime(d: string): string {
  if (/^[+-]\d+-\d\d-\d\dT/.test(d)) return d;
  const m = /^(\d{4})(?:-(\d\d))?(?:-(\d\d))?$/.exec(d);
  if (!m) throw new Error(`date ${d} is not YYYY, YYYY-MM or YYYY-MM-DD`);
  const precision = m[3] ? 11 : m[2] ? 10 : 9;
  return `+${m[1]}-${m[2] ?? "00"}-${m[3] ?? "00"}T00:00:00Z/${precision}`;
}

/** Newlines and tabs would split the QS line. Collapsing whitespace changes nothing else. */
const clean = (t: string) => t.replace(/\s+/g, " ").trim();

/**
 * Enclosing pairs, and the marks that make stripping them unsafe when they
 * also appear inside. ’ is left out for ‘…’ because it doubles as an apostrophe.
 */
const PAIRS: Array<[string, string, string[]]> = [
  ['"', '"', ['"']],
  ["“", "”", ["“", "”"]],
  ["'", "'", ["'"]],
  ["‘", "’", ["‘"]],
  ["«", "»", ["«", "»"]],
];

/**
 * Quotations go on Wikidata without enclosing quote marks, but the original
 * text may use quote marks too: `“A” and “B”` starts and ends with them and
 * is not wrapped. Strip only when the same marks don't appear inside.
 */
function wrapping(t: string): {
  text: string;
  state: "none" | "strip" | "unsure";
} {
  const pair = PAIRS.find(
    ([open, close]) => t.length > 1 && t.startsWith(open) && t.endsWith(close),
  );
  if (!pair) return { text: t, state: "none" };
  const inner = t.slice(1, -1);
  if (pair[2].some((mark) => inner.includes(mark)))
    return { text: t, state: "unsure" };
  return { text: inner.trim(), state: "strip" };
}
const UNSURE =
  "starts and ends with quote marks that also appear inside, so they may be the original text's; left as is, check by hand";

function formatValue(raw: string, datatype: string, lang: string): string {
  switch (datatype) {
    case "wikibase-item":
      return raw.trim().toUpperCase();
    case "time":
      return qsTime(raw.trim());
    case "monolingualtext":
      return `${lang}:"${clean(raw)}"`;
    case "string":
    case "external-id":
    case "url":
    case "commonsMedia":
      return `"${clean(raw)}"`;
    default:
      return raw.trim();
  }
}

const show = (v: Val): string => {
  switch (v.kind) {
    case "item":
      return v.id;
    case "string":
      return `"${short(v.text, 60)}"`;
    case "mono":
      return `${v.lang}:"${short(v.text, 60)}"`;
    case "time":
      return `${v.time}/${v.precision}`;
    case "quantity":
      return String(v.amount);
    case "special":
      return v.v;
    default:
      return v.raw;
  }
};
const short = (t: string, n: number) =>
  t.length > n ? t.slice(0, n - 1) + "…" : t;

// --- batch file ------------------------------------------------------------

type Doc = { head: string; chunks: string[] };

function readDoc(path: string): Doc {
  const md = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const [head, ...chunks] = md.split(/^(?=## Chunk )/m);
  return { head, chunks };
}
const writeDoc = (path: string, d: Doc) =>
  writeFileSync(path, d.head + d.chunks.join(""));

const chunkNo = (c: string) => Number(/^## Chunk (\d+)/.exec(c)?.[1]);
const chunkTitle = (c: string) => /^## (.*)$/m.exec(c)?.[1] ?? "";
const getStatus = (c: string) => /^Status: ([\w-]+)/m.exec(c)?.[1] ?? "?";
const setStatus = (c: string, s: string) =>
  c.replace(/^Status: [\w-]+/m, `Status: ${s}`);
const qsBlock = (c: string) => /^```qs\n([\s\S]*?)^```/m.exec(c)?.[1] ?? "";
const getLines = (c: string) =>
  qsBlock(c)
    .split("\n")
    .filter((l) => l.trim())
    .map(parseLine);

/** Replaces a generated section, leaving everything the user wrote alone. */
function setSection(c: string, name: string, body: string): string {
  const block = `<!-- ${name} -->\n${body.trim()}\n<!-- /${name} -->`;
  const re = new RegExp(`<!-- ${name} -->[\\s\\S]*?<!-- /${name} -->`);
  if (re.test(c)) return c.replace(re, block);
  return c.replace(/^Log:$/m, `${block}\n\nLog:`);
}
const appendLog = (c: string, entry: string) =>
  c.trimEnd() + `\n- ${now()} ${entry}\n\n`;

function selectChunks(d: Doc, n?: string): number[] {
  const all = d.chunks.map((_, i) => i);
  if (!n) return all;
  const i = d.chunks.findIndex((c) => chunkNo(c) === Number(n));
  if (i < 0) throw new Error(`no chunk ${n}`);
  return [i];
}

// --- draft -----------------------------------------------------------------

/** Repo-relative when inside the repo, absolute otherwise. */
function showPath(p: string) {
  const rel = relative(process.cwd(), resolve(p));
  return (rel.startsWith("..") ? resolve(p) : rel).replace(/\\/g, "/");
}

function slugify(t: string) {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

async function draft(inputPath: string) {
  const input: Input = JSON.parse(readFileSync(inputPath, "utf8"));
  if (!input.goal || !Array.isArray(input.statements))
    throw new Error("input needs `goal` and `statements`");
  const out = join(
    OUT_DIR,
    `${today()}-${input.slug ?? slugify(input.goal)}.md`,
  );
  if (existsSync(out) && !process.argv.includes("--force"))
    throw new Error(
      `${out} exists. Revise its chunks instead, or pass --force.`,
    );

  const pids = new Set(["P854", "P248", "P813", "P1476", "P1683"]);
  const qids = new Set<string>();
  for (const st of input.statements) {
    pids.add(st.property.toUpperCase());
    qids.add(st.subject.toUpperCase());
    if (/^Q\d+$/i.test(st.value)) qids.add(st.value.toUpperCase());
    for (const p of Object.keys(st.qualifiers ?? {})) pids.add(p.toUpperCase());
  }
  const ents = await getEntities([...pids, ...qids]);
  const label = (id: string) => `${ents[id]?.labels?.en?.value ?? "?"} (${id})`;
  const dtype = (pid: string) => ents[pid]?.datatype ?? "?";

  const groups = new Map<string, Array<{ line: string; prov: string }>>();
  for (const st of input.statements) {
    const lang = st.lang ?? input.lang ?? "en";
    const pid = st.property.toUpperCase();
    const cols = [
      st.subject.toUpperCase(),
      pid,
      formatValue(st.value, dtype(pid), lang),
    ];
    for (const [q, vs] of Object.entries(st.qualifiers ?? {})) {
      for (const v of [vs].flat())
        cols.push(
          q.toUpperCase(),
          formatValue(v, dtype(q.toUpperCase()), lang),
        );
    }
    const sources = st.sources ?? (st.source ? [st.source] : []);
    const notes: string[] = [];
    sources.forEach((src, i) => {
      const bang = i ? "!" : "";
      const l = src.lang ?? lang;
      const refCols: string[] = [];
      if (src.url) refCols.push("S854", `"${clean(src.url)}"`);
      if (src.statedIn) refCols.push("S248", src.statedIn.toUpperCase());
      if (src.title) refCols.push("S1476", `${l}:"${clean(src.title)}"`);
      for (const q of [src.quote ?? []].flat()) {
        const { text, state } = wrapping(clean(q));
        if (clean(q) !== q) notes.push("quote whitespace collapsed");
        if (state === "strip") notes.push("enclosing quote marks removed");
        if (state === "unsure") notes.push(`quote ${UNSURE}`);
        refCols.push("S1683", `${l}:"${text}"`);
      }
      const retrieved = src.retrieved ?? input.retrieved ?? today();
      refCols.push("S813", qsTime(retrieved));
      refCols[0] = bang + refCols[0];
      cols.push(...refCols);
    });
    const z = st.zotero ?? {};
    const zbits = [
      z.item && `item [${z.item}](zotero://select/library/items/${z.item})`,
      z.annotation &&
        (z.attachment
          ? `annotation [${z.annotation}](zotero://open-pdf/library/items/${z.attachment}?annotation=${z.annotation})`
          : `annotation ${z.annotation}`),
    ].filter(Boolean);
    const value = /^Q\d+$/i.test(st.value)
      ? label(st.value.toUpperCase())
      : `"${short(st.value, 60)}"`;
    const prov =
      `${label(st.subject.toUpperCase())} · ${ents[pid]?.labels?.en?.value ?? "?"} (${pid}) · ${value}` +
      ` · Zotero ${zbits.join(", ") || "(no provenance given)"}` +
      [...new Set(notes), st.note]
        .filter(Boolean)
        .map((n) => `\n   note: ${n}`)
        .join("");
    const key = st.chunk ?? label(st.subject.toUpperCase());
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ line: cols.join("\t"), prov });
  }

  const snap = loadRepo();
  const targets = [...qids]
    .filter((q) => input.statements.some((s) => s.subject.toUpperCase() === q))
    .map(label);
  const head = `# QS batch: ${input.goal}

- Goal: ${input.goal}
- Collection: ${input.collection ?? "(not given)"}
- Targets: ${targets.join(", ")}
- Snapshot: crawledAt ${snap.crawledAt}
- Input: ${showPath(inputPath)}

Paste one chunk at a time into QuickStatements (V1 commands), keeping the
tabs. Statuses: pending, run, verified, revised, skipped, done-manually. Work
resumes at the first chunk that is not verified, skipped or done-manually
(\`qs.ts next\`). Provenance is listed by line number: keep it in step when
revising a chunk.

`;
  const chunks = [...groups].map(
    ([title, rows], i) => `## Chunk ${i + 1}: ${title}

Status: pending

\`\`\`qs
${rows.map((r) => r.line).join("\n")}
\`\`\`

Provenance:

${rows.map((r, j) => `${j + 1}. ${r.prov}`).join("\n")}

Log:

- ${now()} drafted

`,
  );
  const doc: Doc = { head, chunks };
  await runChecks(doc, selectChunks(doc), snap);
  mkdirSync(OUT_DIR, { recursive: true });
  writeDoc(out, doc);
  console.log(`Wrote ${relative(process.cwd(), out)}`);
  summary(doc);
}

// --- check -----------------------------------------------------------------

/** Why a statement will or won't become an edge, per the graph's schema. */
function drawNote(s: Snapshot, l: Line): string {
  const name = labeller(s);
  const scope = new Set(s.scope);
  const core = coreSet(s);
  const bridged = EDGE_PROPERTIES.filter((c: any) => c.via?.pid === l.pid);
  if (bridged.length)
    return `graph: ${l.pid} is a bridge; ${bridged.map((c: any) => c.pid).join(", ")} on the target will draw from the subject`;
  const cfg = EDGE_PROPERTIES.find((c: any) => c.pid === l.pid);
  if (!cfg) return `graph: no edge (${l.pid} is not an edge property)`;
  if (l.val.kind !== "item") return "graph: no edge (value is not an item)";
  const target = l.val.id;
  // A statement on a bridge item draws from whoever in scope points at it.
  const holders = scope.has(l.subject)
    ? [l.subject]
    : cfg.via
      ? s.scope.filter((q) =>
          s.entities[q]?.claims[cfg.via.pid]?.some(
            (x) => x.value === l.subject,
          ),
        )
      : [];
  const blockers: string[] = [];
  if (!holders.length)
    blockers.push("subject not in scope; needs a seed or a tier");
  else if (cfg.coreOnly && !holders.some((h) => core.has(h)))
    blockers.push(`${l.pid} is coreOnly and the subject is not root or tier-1`);
  let later = "";
  if (!s.entities[target]) {
    if (blockers.length) blockers.push(`target ${name(target)} not cached`);
    else later = ` after a re-crawl caches ${name(target)}`;
  }
  if (blockers.length) return `graph: won't draw: ${blockers.join("; ")}`;
  const via = holders[0] !== l.subject ? ` via ${name(l.subject)}` : "";
  const off = cfg.enabled ? "" : ", toggled off by default";
  return `graph: draws "${cfg.edgeLabel ?? cfg.property}"${via}${off}${later}`;
}

/** Text that QS may not carry through untouched. */
function textHazards(t: string): string[] {
  const out: string[] = [];
  if (t.length > MAX_TEXT)
    out.push(`${t.length} characters, over Wikidata's ${MAX_TEXT} limit`);
  if (t.includes('"'))
    out.push(
      "contains straight double quotes. QS keeps them (its value pattern is greedy) but can't escape them; check the saved text with verify",
    );
  if (/[“”]/.test(t))
    out.push(
      "contains curly double quotes. QS 3.0 turns them into straight ones (QS 2 keeps them); verify will show if the saved quote changed",
    );
  if (t.includes("|"))
    out.push(
      "contains |, which QS reads as a column separator when quotes don't pair up",
    );
  if (t.includes("/*") || t.includes("*/"))
    out.push("contains /* or */, which QS reads as an edit-summary comment");
  return out;
}

async function runChecks(d: Doc, idx: number[], s = loadRepo()) {
  const name = labeller(s);
  const lines = idx.flatMap((i) => getLines(d.chunks[i]));
  const ids = new Set<string>();
  for (const l of lines) {
    if (/^Q\d+$/.test(l.subject)) ids.add(l.subject);
    for (const sn of snaks(l)) {
      if (/^P\d+$/.test(sn.pid)) ids.add(sn.pid);
      if (sn.val.kind === "item") ids.add(sn.val.id);
    }
  }
  const ents = await getEntities([...ids]);
  const live = await getEntities(
    [...new Set(lines.map((l) => l.subject))].filter((q) => /^Q\d+$/.test(q)),
    "claims",
  );

  for (const i of idx) {
    const out: string[] = [];
    getLines(d.chunks[i]).forEach((l, j) => {
      const warn: string[] = [...l.errors];
      const info: string[] = [];
      for (const id of [
        l.subject,
        ...snaks(l).flatMap((x) => [
          x.pid,
          x.val.kind === "item" ? x.val.id : "",
        ]),
      ]) {
        const e = ents[id];
        if (!id || !e) continue;
        if (e.missing !== undefined) warn.push(`${id} does not exist`);
        else if (e.id !== id) warn.push(`${id} redirects to ${e.id}`);
      }
      for (const sn of snaks(l)) {
        const dt = ents[sn.pid]?.datatype;
        if (sn.val.kind === "bad")
          warn.push(`${sn.pid}: can't read value ${sn.val.raw}`);
        else if (
          dt &&
          sn.val.kind !== "special" &&
          KIND[dt] &&
          KIND[dt] !== sn.val.kind
        )
          warn.push(`${sn.pid} expects ${dt}, got ${sn.val.kind}`);
        if (
          dt === "url" &&
          sn.val.kind === "string" &&
          !URL.canParse(sn.val.text)
        )
          warn.push(`${sn.pid}: not a valid URL`);
        if (sn.val.kind === "string" || sn.val.kind === "mono")
          for (const h of textHazards(sn.val.text))
            warn.push(`${sn.pid} text ${h}`);
        if (sn.pid === "P1683" && "text" in sn.val) {
          const w = wrapping(sn.val.text).state;
          if (w === "strip")
            warn.push(
              "P1683 quote is wrapped in its own quote marks; Wikidata quotations go without them",
            );
          if (w === "unsure") warn.push(`P1683 quote ${UNSURE}`);
        }
      }
      if (!l.refs.length) warn.push("no reference");
      l.refs.forEach((g, k) => {
        const has = (p: string) => g.some((x) => x.pid === p);
        const tag = l.refs.length > 1 ? `reference ${k + 1}` : "reference";
        if (!has("P854") && !has("P248"))
          warn.push(`${tag} has neither a URL (S854) nor stated in (S248)`);
        if (!has("P813")) warn.push(`${tag} has no retrieved date (S813)`);
      });

      // Already on Wikidata?
      const existing = findStatement(live[l.subject]?.claims?.[l.pid], l.val);
      if (existing) {
        const n = existing.st.references?.length ?? 0;
        const dup = l.refs.filter(
          (g) => bestRef(g, existing.st.references ?? []).missing.length === 0,
        );
        info.push(
          `already on Wikidata with ${n} reference(s); QS adds this line's reference to it`,
        );
        if (dup.length)
          warn.push(
            `${dup.length === l.refs.length ? "every" : "a"} reference in this line is already on the statement; running it may add a duplicate`,
          );
        for (const g of l.refs) {
          const b = bestRef(g, existing.st.references ?? []);
          const same = g.filter(
            (x) => ["P854", "P248"].includes(x.pid) && !b.missing.includes(x),
          );
          if (b.missing.length && same.length)
            warn.push(
              `the statement already has a reference with this ${same.map((x) => (x.pid === "P854" ? "URL" : "stated in")).join(" and ")}; QS adds a second, separate reference. Add the missing parts to the existing one by hand instead?`,
            );
        }
        const missingQ = l.qualifiers.filter(
          (q) =>
            !(existing.st.qualifiers?.[q.pid] ?? []).some((x: any) =>
              sameValue(q.val, x),
            ),
        );
        if (missingQ.length)
          info.push(
            `QS will add qualifier(s) ${missingQ.map((q) => q.pid).join(", ")} to the existing statement`,
          );
      }

      // Already cited in the snapshot?
      for (const sn of l.refs.flat()) {
        const text =
          sn.val.kind === "string" || sn.val.kind === "mono" ? sn.val.text : "";
        if (sn.pid === "P854" && text) {
          const hits = findCitations(s, text).filter((c) =>
            c.refs.some(
              (r) => r.ref.url && normUrl(r.ref.url) === normUrl(text),
            ),
          );
          if (hits.length)
            info.push(`URL already cited on ${citeList(s, hits)}`);
        }
        if (sn.pid === "P1683" && text) {
          const hits = findCitations(s, normText(text).slice(0, 80)).filter(
            (c) => c.refs.some((r) => r.hits.includes("quotation")),
          );
          if (hits.length)
            info.push(`quote already cited on ${citeList(s, hits)}`);
        }
      }
      if (!warn.some((w) => w.endsWith("does not exist")))
        info.push(drawNote(s, l));

      out.push(
        `- Line ${j + 1}: ${name(l.subject)} ${l.pid} ${show(l.val)}`,
        ...warn.map((w) => `  - warn: ${w}`),
        ...info.map((w) => `  - ${w}`),
      );
    });
    d.chunks[i] = setSection(
      d.chunks[i],
      "check",
      `Check ${now()} (live Wikidata; graph snapshot crawled ${s.crawledAt}):\n\n${out.join("\n")}`,
    );
  }
  d.head = d.head.replace(
    /^- Snapshot: .*$/m,
    `- Snapshot: crawledAt ${s.crawledAt} (checked ${now()})`,
  );
}

function citeList(s: Snapshot, hits: ReturnType<typeof findCitations>) {
  const name = labeller(s);
  const list = hits
    .slice(0, 3)
    .map(
      (h) =>
        `${name(h.subject)} ${h.pid} ${h.statement.type === "q" ? name(h.statement.value) : short(h.statement.value, 30)}`,
    );
  return (
    list.join("; ") + (hits.length > 3 ? ` and ${hits.length - 3} more` : "")
  );
}

async function check(path: string, n?: string) {
  const d = readDoc(path);
  await runChecks(d, selectChunks(d, n));
  writeDoc(path, d);
  for (const i of selectChunks(d, n)) {
    console.log(`## ${chunkTitle(d.chunks[i])} [${getStatus(d.chunks[i])}]`);
    console.log(
      /<!-- check -->\n([\s\S]*?)<!-- \/check -->/.exec(d.chunks[i])?.[1],
    );
  }
}

// --- matching against Wikidata JSON -----------------------------------------

type Match = "exact" | "loose" | false;

function datePart(t: string, precision: number) {
  const m = /^([+-]\d+)-(\d\d)-(\d\d)/.exec(t)!;
  return [m[1].replace(/^\+0*/, "+"), m[2], m[3]]
    .slice(0, precision >= 11 ? 3 : precision === 10 ? 2 : 1)
    .join("-");
}

/** Compares a parsed QS value with a Wikidata snak. */
function sameValue(v: Val, snak: any): Match {
  if (v.kind === "special") return snak.snaktype === v.v ? "exact" : false;
  const dv = snak.datavalue?.value;
  if (dv === undefined) return false;
  switch (v.kind) {
    case "item":
      return dv.id === v.id ? "exact" : false;
    case "string":
      if (dv === v.text) return "exact";
      return normText(dv) === normText(v.text) ||
        normUrl(dv) === normUrl(v.text)
        ? "loose"
        : false;
    case "mono":
      if (dv.language !== v.lang) return false;
      if (dv.text === v.text) return "exact";
      return normText(dv.text) === normText(v.text) ? "loose" : false;
    case "time":
      return dv.precision === v.precision &&
        datePart(dv.time, v.precision) === datePart(v.time, v.precision)
        ? "exact"
        : false;
    case "quantity":
      return Number(dv.amount) === v.amount ? "exact" : false;
    default:
      return false;
  }
}

function findStatement(claims: any[] | undefined, v: Val) {
  for (const st of claims ?? []) {
    const m = sameValue(v, st.mainsnak);
    if (m) return { st, match: m };
  }
  return null;
}

/** The Wikidata reference that holds most of a batch reference group. */
function bestRef(group: Snak[], refs: any[]) {
  let best = { ref: null as any, missing: group, loose: [] as Snak[] };
  for (const ref of refs) {
    const missing: Snak[] = [];
    const loose: Snak[] = [];
    for (const sn of group) {
      const m = (ref.snaks[sn.pid] ?? [])
        .map((x: any) => sameValue(sn.val, x))
        .reduce((a: Match, b: Match) => (a === "exact" ? a : b || a), false);
      if (!m) missing.push(sn);
      else if (m === "loose") loose.push(sn);
    }
    if (missing.length < best.missing.length) best = { ref, missing, loose };
  }
  return best;
}

function describeRef(s: Snapshot, ref: any): string {
  const name = labeller(s);
  const val = (pid: string) =>
    (ref.snaks[pid] ?? []).map((x: any) => x.datavalue?.value);
  const bits = [
    ...val("P248").map((v: any) => `stated in ${name(v.id)}`),
    ...val("P854").map((v: string) => v),
    ...val("P1683").map((v: any) => `> ${short(v.text, 80)}`),
  ];
  const other = Object.keys(ref.snaks).filter(
    (p) => !["P248", "P854", "P1683", "P813", "P1476"].includes(p),
  );
  if (other.length) bits.push(`also ${other.join(", ")}`);
  return bits.join(" · ") || "(empty)";
}

/** Whether the snapshot already knew a reference: same URL, source or quote. */
function refInSnapshot(s: Snapshot, subject: string, pid: string, ref: any) {
  const url = ref.snaks.P854?.[0]?.datavalue?.value;
  const stated = ref.snaks.P248?.[0]?.datavalue?.value?.id;
  const quote = ref.snaks.P1683?.[0]?.datavalue?.value?.text;
  return (s.entities[subject]?.claims[pid] ?? []).some((st) =>
    (st.references ?? []).some(
      (r) =>
        (url && r.url && normUrl(r.url) === normUrl(url)) ||
        (!url && stated && r.statedIn === stated) ||
        (quote && r.quotations?.some((q) => normText(q) === normText(quote))),
    ),
  );
}

// --- verify ----------------------------------------------------------------

async function verify(path: string, n?: string) {
  const d = readDoc(path);
  const s = loadRepo();
  const name = labeller(s);
  const idx = selectChunks(d, n);
  const subjects = idx
    .flatMap((i) => getLines(d.chunks[i]))
    .map((l) => l.subject)
    .filter((q) => /^Q\d+$/.test(q));
  const live = await getEntities(subjects, "claims");

  for (const i of idx) {
    const lines = getLines(d.chunks[i]);
    const out: string[] = [];
    let complete = 0;
    let partial = 0;
    lines.forEach((l, j) => {
      const claims = live[l.subject]?.claims?.[l.pid];
      const found = findStatement(claims, l.val);
      const head = `- Line ${j + 1}: ${name(l.subject)} ${l.pid} ${show(l.val)}`;
      if (!found) {
        out.push(`${head}: not on Wikidata`);
        return;
      }
      const notes: string[] = [];
      if (found.match === "loose")
        notes.push("value saved with different quote marks or spacing");
      const missingQ = l.qualifiers.filter(
        (q) =>
          !(found.st.qualifiers?.[q.pid] ?? []).some((x: any) =>
            sameValue(q.val, x),
          ),
      );
      if (missingQ.length)
        notes.push(
          `missing qualifier(s) ${missingQ.map((q) => q.pid).join(", ")}`,
        );
      const refs: any[] = found.st.references ?? [];
      const used = new Set<any>();
      let refsOk = true;
      l.refs.forEach((g, k) => {
        const b = bestRef(g, refs);
        const tag = l.refs.length > 1 ? `reference ${k + 1}` : "reference";
        if (b.ref) used.add(b.ref);
        if (!b.ref || b.missing.length === g.length) {
          refsOk = false;
          notes.push(`${tag} not found`);
        } else if (b.missing.length) {
          refsOk = false;
          notes.push(
            `${tag} partly there, missing ${b.missing.map((x) => "S" + x.pid.slice(1)).join(", ")}`,
          );
        } else if (b.loose.length) {
          notes.push(
            `${tag} found; ${b.loose.map((x) => "S" + x.pid.slice(1)).join(", ")} saved with different quote marks or spacing`,
          );
        }
      });
      // References the batch didn't write: detail only the ones the snapshot lacks.
      const others = refs.filter((r) => !used.has(r));
      const known = others.filter((r) => refInSnapshot(s, l.subject, l.pid, r));
      for (const ref of others.filter((r) => !known.includes(r)))
        notes.push(
          `extra reference, not from this batch and new since the snapshot (added by hand?): ${describeRef(s, ref)}`,
        );
      if (known.length)
        notes.push(
          `${known.length} other reference(s), already in the snapshot`,
        );
      const ok = refsOk && !missingQ.length;
      if (ok) complete++;
      else partial++;
      out.push(
        `${head}: ${ok ? "found" : "partly there"}`,
        ...notes.map((x) => `  - ${x}`),
      );
    });

    // Statements on the chunk's subjects and properties the batch didn't write.
    const seen = new Set<string>();
    for (const l of lines) {
      const key = `${l.subject} ${l.pid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const st of live[l.subject]?.claims?.[l.pid] ?? []) {
        if (
          lines.some(
            (x) =>
              x.subject === l.subject &&
              x.pid === l.pid &&
              sameValue(x.val, st.mainsnak),
          )
        )
          continue;
        const v = st.mainsnak.datavalue?.value;
        const id = v?.id;
        const inSnap = (s.entities[l.subject]?.claims[l.pid] ?? []).some(
          (x) => x.value === id,
        );
        if (inSnap) continue;
        out.push(
          `- Extra: ${name(l.subject)} ${l.pid} ${id ? name(id) : JSON.stringify(v)} is on Wikidata but not in this batch or the snapshot (added by hand?), ${st.references?.length ?? 0} reference(s)`,
        );
      }
    }

    const before = getStatus(d.chunks[i]);
    let after = before;
    // Only moves forward; skipped, done-manually and verified stay put.
    if (!FINISHED.has(before)) {
      if (complete === lines.length && lines.length) after = "verified";
      else if (complete + partial > 0 && before === "pending") after = "run";
    }
    const result = `${complete}/${lines.length} lines complete${partial ? `, ${partial} partly there` : ""}`;
    let c = setSection(
      d.chunks[i],
      "verify",
      `Verify ${now()} against live Wikidata: ${result}\n\n${out.join("\n")}`,
    );
    c = setStatus(c, after);
    c = appendLog(
      c,
      `verify: ${result}${after !== before ? `; ${before} → ${after}` : ""}`,
    );
    d.chunks[i] = c;
    console.log(`## ${chunkTitle(c)} [${after}]\n${out.join("\n")}\n`);
  }
  writeDoc(path, d);
  summary(d);
}

// --- progress --------------------------------------------------------------

function summary(d: Doc) {
  const counts: Record<string, number> = {};
  for (const c of d.chunks)
    counts[getStatus(c)] = (counts[getStatus(c)] ?? 0) + 1;
  const next = d.chunks.find((c) => !FINISHED.has(getStatus(c)));
  console.log(
    `${d.chunks.length} chunk(s): ${Object.entries(counts)
      .map(([k, v]) => `${v} ${k}`)
      .join(", ")}. ${next ? `Next: ${chunkTitle(next)}` : "All finished."}`,
  );
}

function next(path: string) {
  const d = readDoc(path);
  summary(d);
  const c = d.chunks.find((x) => !FINISHED.has(getStatus(x)));
  if (!c) return;
  const notes = /<!-- check -->\n([\s\S]*?)<!-- \/check -->/.exec(c)?.[1];
  const log = c.slice(c.indexOf("\nLog:")).trim();
  console.log(
    `\n## ${chunkTitle(c)}\nStatus: ${getStatus(c)}\n\n${qsBlock(c)}\n${notes ?? ""}\n${log}`,
  );
}

function mark(path: string, n: string, status: string, note: string) {
  if (!STATUSES.includes(status))
    throw new Error(`status must be one of ${STATUSES.join(", ")}`);
  const d = readDoc(path);
  const [i] = selectChunks(d, n);
  const before = getStatus(d.chunks[i]);
  d.chunks[i] = appendLog(
    setStatus(d.chunks[i], status),
    `${before} → ${status}${note ? `: ${note}` : ""}`,
  );
  writeDoc(path, d);
  summary(d);
}

// --- cli -------------------------------------------------------------------

const [cmd, ...args] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const usage = () => {
  console.log(
    readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0],
  );
  process.exit(1);
};
if (!args[0]) usage();
switch (cmd) {
  case "draft":
    await draft(args[0]);
    break;
  case "check":
    await check(args[0], args[1]);
    break;
  case "verify":
    await verify(args[0], args[1]);
    break;
  case "next":
    next(args[0]);
    break;
  case "mark":
    if (!args[2]) usage();
    mark(args[0], args[1], args[2], args.slice(3).join(" "));
    break;
  default:
    usage();
}
