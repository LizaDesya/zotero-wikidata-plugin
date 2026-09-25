# Prototyping reference

The working reference for the experimental phase. Everything here is
provisional. It records what we're trying, not decisions. When a tool or
convention has proven itself in real sessions, it becomes a candidate for the
formal plugin.

## Layout

- `sandbox/docs/`: this file and
  [zotero-to-wikidata-pipeline.md](zotero-to-wikidata-pipeline.md), which
  describes the current workflow and the one we want.
- `sandbox/scripts/`: small read-only tools for agent sessions. They run with
  plain `node` (v25 strips TypeScript types) and need no dependencies.

## The workflow in one line

Zotero annotations (quotes on snapshots and PDFs) → reviewed with an agent →
QuickStatements batches with references → run by the user → re-crawled into
the CCRU graph on hijinx.world.

## The CCRU graph (hijinx-world-website)

The graph sets the target shape: an edit only matters once the graph can
draw it. Read the graph's schema before inventing one here.

- Sibling repo: `../hijinx-world-website` (override with `HIJINX_REPO`).
- The schema is `src/components/ccru-graph/schema.ts`. It holds
  `EDGE_PROPERTIES` (drawn PIDs, `invert`, `via` bridges, `coreOnly`,
  `enabled`), `NODE_CLASSES` (P31 to class, first match wins) and the date
  properties. Read this file rather than copying it.
- The snapshot is `public/interactive/2026-ccru-graph/graph.json` in the repo
  and https://hijinx.world/interactive/2026-ccru-graph/graph.json live.
  Its shape is described in `src/components/ccru-graph/types.ts`. References
  keep `url` (P854), `statedIn` (P248), `title` (P1476) and `quotations`
  (P1683). Those last ones are the annotation quotes.
- Only items in `scope` emit edges. The scope is the SPARQL tiers in
  `scripts/ccru/seeds.json` plus its hand-kept seeds. A statement drawn from
  an out-of-scope item, or pointing at an uncached target, is silently not
  drawn. `coreOnly` properties only draw from root plus the tier-1 roster.
- Refresh with `pnpm ccru:crawl --refresh` in that repo. It is the user's
  step to run.

## Tools

### `sandbox/scripts/ccru.ts`

A read-only CLI over the graph. It imports `schema.ts` from the hijinx repo,
so its edge rules match the site's.

```sh
node sandbox/scripts/ccru.ts status        # repo vs live snapshot drift
node sandbox/scripts/ccru.ts find <text>   # label search, marks scope/pruned/label-only
node sandbox/scripts/ccru.ts item <QID>    # class, scope, drawn edges + refs, why not drawn
node sandbox/scripts/ccru.ts wd <QID>      # snapshot vs live Wikidata, incl. incoming (SPARQL)
node sandbox/scripts/ccru.ts ref <text|URL|QID>  # every statement citing a quote, URL or source
```

Add `--live` to read the published JSON. Use `wd` after an edit to see
whether it reached Wikidata and whether a re-crawl is needed. Use `ref` before
drafting a statement from an annotation, to check whether that quote or URL is
already cited. It ignores differences in quote marks, spacing and URL scheme.
A QID lists everything whose reference says "stated in" that source.

### `sandbox/scripts/qs.ts`

Drafts QuickStatements batches from reviewed annotations and tracks which
chunks have run. It never writes to Wikidata. Shared helpers (snapshot,
schema, `wbgetentities`, citation search) live in `sandbox/scripts/lib.ts`,
which `ccru.ts` uses too.

```sh
node sandbox/scripts/qs.ts draft <input.json>      # write sandbox/statements/<date>-<slug>.md
node sandbox/scripts/qs.ts check <batch.md> [n]    # warnings per line, before running
node sandbox/scripts/qs.ts verify <batch.md> [n]   # compare with live Wikidata, update status
node sandbox/scripts/qs.ts next <batch.md>         # progress, and the first unfinished chunk
node sandbox/scripts/qs.ts mark <batch.md> <n> <status> [note]
```

`sandbox/statements/` is git-ignored: batches and their input files are
one-off working files. Put the input JSON next to the batch.

**Input.** The agent writes it from Zotero with the user. Nothing produces it
automatically yet: the planned annotation digest tool will. There is no tag
vocabulary. Each entry says what to state, and nothing maps tags to
properties.

```jsonc
{
  "goal": "Parisi membership refs", // batch title; slug comes from it unless "slug" is set
  "collection": "CCRU Wikidata Project / People / Luciana Parisi",
  "retrieved": "2026-09-25", // default S813 date (default: today)
  "lang": "en", // default language for titles and quotes
  "statements": [
    {
      "chunk": "Parisi", // optional; defaults to one chunk per subject
      "subject": "Q112500788",
      "property": "P463",
      "value": "Q24942459", // QID, or a plain value formatted by the property's datatype
      "qualifiers": { "P580": "1995" }, // value or array of values
      "source": {
        // or "sources": [ ... ] for several reference groups (!S)
        "url": "https://…",
        "statedIn": "Q…",
        "title": "…",
        "quote": "…", // or an array
        "retrieved": "2026-09-25",
        "lang": "en",
      },
      "lang": "en",
      "zotero": { "item": "KEY", "attachment": "KEY", "annotation": "KEY" },
      "note": "free text, shown under the provenance line",
    },
  ],
}
```

Plain values follow the property's datatype, looked up live: dates as
`YYYY`, `YYYY-MM` or `YYYY-MM-DD` (QS precision `/9`, `/10`, `/11`),
strings and URLs quoted, monolingual text as `lang:"…"`. Zotero keys never
enter the QS text. They go in the provenance list, with `zotero://` links.

**Batch file.** A header (goal, targets, collection, snapshot `crawledAt`,
input path), then `## Chunk n: …` sections, each with `Status:`, a fenced
`qs` block ready to paste, a provenance list numbered by line, generated
`<!-- check -->` and `<!-- verify -->` sections, and a `Log:` list. Anything
outside the generated sections is yours to edit, and the script only rewrites
the status line, those sections and the log.

- Statuses: `pending`, `run`, `verified`, `revised`, `skipped`,
  `done-manually`. A session resumes at the first chunk that is not
  `verified`, `skipped` or `done-manually` (`next`).
- To revise, edit the chunk's `qs` block, keep its provenance numbering in
  step, `mark <n> revised`, then `check <n>`. Don't draft a new batch.
- `verify` reads live Wikidata, not the snapshot. It moves `pending` to `run`
  when some lines are there, and moves `pending`, `run` or `revised` to
  `verified` when every line, qualifier and reference is there. It never
  moves a chunk back. It records references and statements the batch didn't
  write. Those not in the snapshot either are flagged as probably added by
  hand. Older ones are just counted.
- Keep the tabs. An editor that turns them into spaces breaks the lines, and
  `check` says so.

**Checks** (warnings only): IDs exist and aren't redirects, values match
their property's datatype, text length (1,500 limit), quote hazards (see
below), each reference has a URL or `stated in` plus a retrieved date, the
statement already on Wikidata (QS then adds the reference to it, and a
reference with the same URL would become a second one), the URL or quote
already cited in the snapshot, and whether the graph will draw it, with the
reason if not.

**QS syntax, as verified 2026-09-25** against the help page and both
parsers' source (QS 2 `quickstatements.php`, QS 3.0
`core/parsers/base.py`, `v1.py`):

- `S854 "url"`, `S248 Q…`, `S813 +2026-09-25T00:00:00Z/11`,
  `S1476 en:"…"`, `S1683 en:"…"`. Qualifiers use `P`, and `!S` starts a new
  reference group.
- Both parsers read string values greedily (`^"(.*)"$`), so straight double
  quotes inside a quote survive. There is no escape, and QS 3.0 only guards
  `|` inside quotes that pair up. `check` warns rather than altering the text.
- QS 3.0 replaces curly `“ ”` with straight quotes before parsing, so a
  quote saved through it changes silently. QS 2 keeps them. `verify` reports
  a saved value that differs only in quote marks or spacing.
- `/* … */` at the end of a line becomes the edit summary.
- Wikidata limits strings, URLs and monolingual text to 1,500 characters
  (`wmgWikibaseStringLimits` in wmf-config).

### Also available in agent sessions

- **Zotero MCP**: collections, items, annotations, tags and item edits.
- **`wikidata-query` skill**: verifying QIDs and PIDs, summarising an item's
  statements, running SPARQL, checking constraint violations.

## Notes and lessons

Add dated entries as sessions teach us something.

- 2026-09-25: Wikidata's API refuses `maxlag` requests while the query
  service lags, and the lag can last minutes. Leave `maxlag` off one-off
  reads. It belongs on writes and bulk jobs.
- 2026-09-25: Built `qs.ts` and tested it on a throwaway batch against live
  Wikidata (draft, check, mark, a revision, verify, resume). Its first real
  batch hasn't been run yet, so add that lesson here when it happens. So far:
  the QS syntax rules had to come from the parsers' source, because the help
  page doesn't cover quotes inside V1 strings. `wbgetentities` fails the whole
  request if one ID doesn't exist, so `lib.ts` drops that ID and retries. A
  statement that already exists with the same reference URL gets a second
  reference from QS, not a merged one, and `check` now warns about it.

## Candidates for the plugin

Tools or conventions that have held up across several sessions. Empty until
something earns a place.
