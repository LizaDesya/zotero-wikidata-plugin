# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A Zotero 7/8 plugin for managing **Wikidata sources**: linking Zotero items to
their Wikidata items (QIDs), looking up and comparing metadata, and helping the
user create or improve Wikidata items and references from their Zotero library.

It is a fork of [windingwind/zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template)
(`upstream` remote). `origin` is `LizaDesya/zotero-wikidata-plugin`.

### Current state

Rebranded, with the template demos removed. No features yet: the plugin
registers its preferences pane and nothing else.

- Identity is in `package.json` `config`: addon name "Wikidata for Zotero",
  ID `zotero-wikidata@lizadesya.github.io`, ref `zoterowikidata`, instance
  `Zotero.ZoteroWikidata`, prefs prefix `extensions.zotero.zoterowikidata`.
  These flow into the manifest, bootstrap, FTL file names, pref keys and the
  global object, so change them together and rebuild.
- Prefs: `wikibaseUrl` (defaults to `https://test.wikidata.org`, so nothing
  reaches production until it is changed deliberately) and `editSummary`.
- Locale is `en-US` only; `zh-CN` was dropped deliberately. Only
  `addon.ftl` and `preferences.ftl` exist. Add a `mainWindow.ftl` (and
  `insertFTLIfNeeded` in `onMainWindowLoad`) when the first main-window UI
  lands.
- The icons in `addon/content/icons/` are still the template's.

## Commands

```sh
npm install
npm start           # build + launch Zotero with hot reload (needs .env)
npm run build       # production build to .scaffold/build + tsc --noEmit
npm test            # mocha tests run inside a real Zotero (zotero-plugin test)
npm run lint:check  # prettier --check + eslint
npm run lint:fix
npm run release     # bump version, tag, publish via zotero-plugin-scaffold
```

`npm start` and `npm test` need a `.env` copied from `.env.example` with
`ZOTERO_PLUGIN_ZOTERO_BIN_PATH` and `ZOTERO_PLUGIN_PROFILE_PATH` (use a
dedicated dev profile, never the user's real library). On Windows, escape
backslashes in paths (`C:\\Program Files\\Zotero\\zotero.exe`).

CI (`.github/workflows/ci.yml`) runs lint, build, and test on push/PR to
`main`. Run `npm run lint:check` and `npm run build` before calling a change
done.

## Architecture

Built with `zotero-plugin-scaffold` (esbuild, target `firefox115`) and
`zotero-plugin-toolkit`.

- `addon/bootstrap.js`: Zotero bootstrap entry. Registers chrome, loads the
  bundled script, and forwards lifecycle events to `addon.hooks`.
  `__addonRef__` etc. are replaced at build time from `package.json` `config`.
- `src/index.ts`: creates the singleton `Addon`, exposes it as
  `Zotero[config.addonInstance]` and the globals `addon` and `ztoolkit`.
- `src/addon.ts`: `Addon` class. Runtime state goes in `addon.data`, and any
  public API for other plugins goes in `addon.api`.
- `src/hooks.ts`: lifecycle and event dispatchers (`onStartup`,
  `onShutdown`, `onMainWindowLoad`, `onMainWindowUnload`). Add `onNotify`,
  `onPrefsEvent` and the like as features need them. **Hooks only
  dispatch.** Put real work in `src/modules/`.
- `src/modules/`: feature code. `src/utils/`: shared helpers (`prefs.ts`,
  `locale.ts`, `window.ts`, `ztoolkit.ts`).
- `addon/`: static assets copied into the XPI: `manifest.json`, `prefs.js`,
  `content/` (XHTML, CSS, icons), and `locale/<lang>/*.ftl`.
- `typings/`: `global.d.ts` is hand-written. `prefs.d.ts` and `i10n.d.ts` are
  **generated** by the scaffold from `addon/prefs.js` and the FTL files, so
  don't edit them by hand.

### Conventions

- Clean up everything you register. Use `ztoolkit.unregisterAll()` on window
  unload and shutdown, unregister notifier observers, and check
  `addon.data.alive` in async callbacks.
- Preferences: declare defaults in `addon/prefs.js` (no prefix) and read and
  write through `getPref` / `setPref` in `src/utils/prefs.ts`, which add
  `config.prefsPrefix` and are typed from the generated `prefs.d.ts`.
- User-visible strings go in Fluent `.ftl` files under `addon/locale/`, read
  with `getString()`. `en-US` is the only locale.
- Formatting: Prettier (80 cols, 2 spaces, LF). ESLint uses
  `@zotero-plugin/eslint-config`.
- Tests live in `test/*.test.ts` (mocha + chai) and run inside Zotero with
  `Zotero` globals available.
- Don't hand-edit `package-lock.json` or fight dependabot/renovate bumps.
  Dependency PRs merge on their own.

## Wikidata domain

### Linking Zotero items to Wikidata

- Store the QID in the item's **Extra** field as a line `QID: Q12345`. That's
  the convention other Zotero/Wikidata tooling (e.g. Cita) uses. Parse it
  tolerantly (case-insensitive key, trimmed), and rewrite only that line,
  leaving other Extra content untouched.
- Match items to Wikidata by strong identifiers first (DOI `P356`, PMID
  `P698`, PMCID `P932`, ISBN-13 `P212`, ISBN-10 `P957`, arXiv `P818`), then by
  title and date only as a suggestion the user confirms.
- Normalize DOIs to upper case before querying `P356`, because Wikidata stores
  them upper-cased.

### Frequently used properties

`P31` instance of · `P1476` title · `P50` author · `P2093` author name string ·
`P577` publication date · `P1433` published in · `P478` volume · `P433` issue ·
`P304` pages · `P407` language · `P2860` cites work · `P248` stated in ·
`P854` reference URL · `P813` retrieved.

Never guess a QID or PID. Verify it with the `wikidata-query` skill (or the
API) before hard-coding it or using it in edits.

### API usage

- Endpoints: Action API `https://www.wikidata.org/w/api.php`
  (`wbgetentities`, `wbsearchentities`, `wbeditentity`, ...), REST
  `https://www.wikidata.org/w/rest.php/wikibase/v1/`, and SPARQL
  `https://query.wikidata.org/sparql`.
- Make HTTP calls with `Zotero.HTTP.request` (or `fetch`) from a dedicated
  module, e.g. `src/modules/wikidata/`. Don't scatter requests through UI
  code.
- Always send a descriptive `User-Agent` / `Api-User-Agent` with the plugin
  name, version, and repo URL, as the Wikimedia User-Agent policy requires.
- Batch reads (`wbgetentities` takes up to 50 ids, and SPARQL `VALUES` works
  for bulk lookups), cache results for the session, and honour `maxlag` and
  `Retry-After`. The SPARQL endpoint has a 60 s timeout and rate limits.

### Writing to Wikidata

- **Edits are public and effectively permanent.** Every write must be
  initiated by the user and shown as a diff or preview they confirm first.
  Never write from background notifier callbacks or on startup.
- Authenticate with OAuth or a bot password supplied by the user. Never commit
  credentials, and store them only in Zotero prefs or the login manager, never
  in logs.
- Send `maxlag=5`, use CSRF tokens, and include an edit summary that names the
  plugin.
- Add references (`P248` / `P854` / `P813`) to statements sourced from Zotero
  data.
- When developing, test writes against `https://test.wikidata.org`, never
  production. Make the API base URL configurable for this.
