# efpnode

ENSNode plugin (and standalone reference) for indexing the Ethereum Follow
Protocol (EFP).

The goal is a single, unified ENS + EFP indexer: one ENSNode process, one
Postgres database, one set of RPC endpoints. EFP becomes just another plugin
you toggle on via the `PLUGINS` env variable.

## Layout

- `packages/ensnode-plugin-efp/` — the plugin itself, structured to drop into
  `apps/ensindexer/src/plugins/efp/` in an ENSNode checkout.
- `examples/standalone-ponder/` — runs the plugin against plain Ponder for
  verification without forking ENSNode.
- `docs/RESEARCH.md` — design notes and findings from auditing both projects.

## Status

Experiment / proof-of-concept. See `docs/RESEARCH.md` for design choices and
the exact steps required to land it upstream.
