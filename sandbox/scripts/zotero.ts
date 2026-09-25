/**
 * Read-only digest of Zotero annotations, for agent sessions.
 *
 *   node sandbox/scripts/zotero.ts tag <tag> [--json]    annotations carrying a tag, grouped by source
 *
 * Reads Zotero's local API (Zotero running, "Allow other applications on this
 * computer to communicate with Zotero" on). Never writes to Zotero.
 * --json prints one record per annotation, ready for a qs.ts input file.
 * Set ZOTERO_API to use another base URL.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const API = process.env.ZOTERO_API ?? "http://localhost:23119/api/users/0";

async function get(path: string): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`);
  } catch {
    throw new Error(
      `Zotero's local API is not answering at ${API}. Is Zotero running with the local API enabled?`,
    );
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
  return res.json();
}

/** Follows `start` paging; the API returns at most 100 per request. */
async function getAll(path: string): Promise<any[]> {
  const out: any[] = [];
  for (let start = 0; ; start += 100) {
    const sep = path.includes("?") ? "&" : "?";
    const page = await get(`${path}${sep}limit=100&start=${start}`);
    out.push(...page);
    if (page.length < 100) return out;
  }
}

async function items(keys: string[]): Promise<Record<string, any>> {
  // The local API ignores `itemKey`, so fetch each parent on its own.
  const unique = [...new Set(keys.filter(Boolean))];
  const found = await Promise.all(unique.map((k) => get(`/items/${k}`)));
  return Object.fromEntries(found.map((it) => [it.key, it.data]));
}

/** The QID line other Zotero/Wikidata tooling keeps in Extra. */
const qidOf = (extra = "") => /^\s*qid\s*:\s*(Q\d+)\s*$/im.exec(extra)?.[1];

async function tag(name: string) {
  const anns = (
    await getAll(`/items?tag=${encodeURIComponent(name)}&itemType=annotation`)
  ).map((x) => x.data);
  if (!anns.length) {
    console.log(`No annotations tagged ${name}.`);
    return;
  }
  const atts = await items(anns.map((a) => a.parentItem));
  const parents = await items(Object.values(atts).map((a) => a.parentItem));

  const records = anns.map((a) => {
    const att = atts[a.parentItem] ?? {};
    const src = parents[att.parentItem] ?? att;
    return {
      annotation: a.key,
      attachment: a.parentItem,
      item: src.key ?? a.parentItem,
      type: a.annotationType,
      text: a.annotationText ?? "",
      comment: a.annotationComment ?? "",
      page: a.annotationPageLabel || undefined,
      tags: (a.tags ?? [])
        .map((t: any) => t.tag)
        .filter((t: string) => t !== name),
      sort: a.annotationSortIndex ?? "",
      source: {
        title: src.title ?? att.title,
        itemType: src.itemType,
        date: src.date || undefined,
        url: src.url || att.url || undefined,
        attachmentType: att.contentType,
        qid: qidOf(src.extra),
      },
    };
  });
  records.sort(
    (x, y) =>
      x.item.localeCompare(y.item) ||
      x.attachment.localeCompare(y.attachment) ||
      x.sort.localeCompare(y.sort),
  );

  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        records.map(({ sort: _, ...r }) => r),
        null,
        2,
      ),
    );
    return;
  }
  console.log(`${records.length} annotation(s) tagged ${name}\n`);
  let last = "";
  for (const r of records) {
    if (r.item !== last) {
      last = r.item;
      const s = r.source;
      console.log(
        `## ${s.title ?? "(untitled)"} (${[s.itemType, s.date].filter(Boolean).join(", ")})`,
      );
      console.log(
        `   item ${r.item} · attachment ${r.attachment} (${s.attachmentType ?? "?"})` +
          `${s.url ? ` · ${s.url}` : " · no URL"}${s.qid ? ` · ${s.qid}` : ""}`,
      );
    }
    const page = r.page ? ` p.${r.page}` : "";
    console.log(`- ${r.annotation}${page} [${r.type}] ${r.text}`);
    if (r.comment) console.log(`    comment: ${r.comment}`);
    if (r.tags.length) console.log(`    tags: ${r.tags.join(", ")}`);
  }
}

const [cmd, arg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (cmd === "tag" && arg) await tag(arg);
else {
  console.log(
    readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0],
  );
  process.exit(1);
}
