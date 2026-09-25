# Wikidata for Zotero

A Zotero 7/8 plugin for managing Wikidata sources: linking Zotero items to
their Wikidata items, and turning annotations into referenced Wikidata
statements.

Early development. Nothing is implemented yet beyond the plugin shell and its
preferences.

## Safety

Wikidata edits are public and effectively permanent. The plugin targets
`https://test.wikidata.org` by default (the **Wikibase URL** preference).
Switch to `https://www.wikidata.org` only when you mean to edit production.

## Development

Built on
[windingwind/zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template)
with `zotero-plugin-scaffold` and `zotero-plugin-toolkit`.

```sh
npm install
cp .env.example .env   # set the Zotero binary and a dedicated dev profile
npm start              # build and launch Zotero with hot reload
npm run build
npm test
npm run lint:check
```

See [CLAUDE.md](CLAUDE.md) for architecture and conventions.

## License

AGPL-3.0-or-later
