# Drop-in files for ENSIndexer

These two files are the *only* pieces of `@efpnode/ensnode-plugin-efp` that
import ENSNode-internal module paths (`@/lib/...`, `@ensnode/...`, `ponder`).
They are excluded from this package's `tsc --noEmit` check because those
modules don't exist outside an ENSNode checkout.

## Installation

1. Copy this whole package's `src/` tree into your ENSNode fork at
   `apps/ensindexer/src/plugins/efp/`. The directory layout matches the
   existing plugins (`registrars`, `tokenscope`, …).
2. Move `dropin/plugin.ts` up one level to
   `apps/ensindexer/src/plugins/efp/plugin.ts`.
3. Move `dropin/event-handlers.ts` up one level to
   `apps/ensindexer/src/plugins/efp/event-handlers.ts`.
4. Copy `src/schema.ts` to
   `packages/ensdb-sdk/src/ensindexer-abstract/efp.schema.ts` and add
   `export * from "./efp.schema";` to the abstract schema's
   `index.ts`.
5. Add `EFP = "efp"` to the `PluginName` enum in
   `packages/ensnode-sdk/src/ensindexer/config/types.ts`.
6. Add the imported plugin to `ALL_PLUGINS` in
   `apps/ensindexer/src/plugins/index.ts`.
7. Wire the handlers into `apps/ensindexer/ponder/src/register-handlers.ts`:

   ```ts
   import attach_EFPHandlers from "@/plugins/efp/event-handlers";

   if (config.plugins.includes(PluginName.EFP)) {
     attach_EFPHandlers();
   }
   ```

8. Run ENSIndexer with `PLUGINS=subgraph,efp` (and the usual
   `RPC_URL_1` / `RPC_URL_10` / `RPC_URL_8453` env vars for the three
   chains EFP touches).

## Why these files use `@ts-expect-error`

The drop-in target paths are stable inside ENSNode but unresolvable from
this standalone repo. Rather than ship two divergent copies of the file,
we use `@ts-expect-error` on the imports so the same source compiles
cleanly once moved into ENSIndexer. When you do the move, delete the
`@ts-expect-error` lines.
