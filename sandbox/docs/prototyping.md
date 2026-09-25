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

### Also available in agent sessions

- **Zotero MCP**: collections, items, annotations, tags and item edits.
- **`wikidata-query` skill**: verifying QIDs and PIDs, summarising an item's
  statements, running SPARQL, checking constraint violations.

## Notes and lessons

Add dated entries as sessions teach us something.

- 2026-09-25: Wikidata's API refuses `maxlag` requests while the query
  service lags, and the lag can last minutes. Leave `maxlag` off one-off
  reads. It belongs on writes and bulk jobs.

## Candidates for the plugin

Tools or conventions that have held up across several sessions. Empty until
something earns a place.
