/**
 * Standalone Ponder event handler registration.
 *
 * In ENSIndexer, the equivalent file is
 * `apps/ensindexer/ponder/src/register-handlers.ts`, which conditionally calls
 * the EFP plugin's `event-handlers.ts` default export when `PluginName.EFP`
 * is enabled. Here we always register, since the standalone app *only*
 * indexes EFP.
 *
 * The handler bodies themselves come straight from the plugin package and
 * are wrapped with `createPonderEFPStore(context.db)` to produce the
 * `EFPStore` interface they expect.
 *
 * NOTE: ponder's event-name type-inference is strict — it requires the
 * literal `"namespace/Contract:Event"` string. We hard-code those literals
 * here (rather than building them from the plugin's `EFP_PLUGIN_NAME` const)
 * so Ponder can narrow `event.args` to the correct shape per handler.
 */

import { ponder } from "ponder:registry";
import type { Hex } from "viem";

import {
  createPonderEFPStore,
  handleListOp,
  handleResolverTextChanged,
  handleTransfer,
  handleUpdateAccountMetadata,
  handleUpdateListMetadata,
  handleUpdateListStorageLocation,
} from "@efpnode/ensnode-plugin-efp";

// -----------------------------------------------------------------------------
// ListRegistry (Base only)
// -----------------------------------------------------------------------------

ponder.on("efp/ListRegistry:Transfer", async ({ context, event }) => {
  await handleTransfer(createPonderEFPStore(context.db as never), {
    args: {
      from: event.args.from as Hex,
      to: event.args.to as Hex,
      tokenId: event.args.tokenId,
    },
    contractAddress: event.log.address as Hex,
    blockTimestamp: event.block.timestamp,
  });
});

ponder.on(
  "efp/ListRegistry:UpdateListStorageLocation",
  async ({ context, event }) => {
    await handleUpdateListStorageLocation(
      createPonderEFPStore(context.db as never),
      {
        args: {
          tokenId: event.args.tokenId,
          listStorageLocation: event.args.listStorageLocation as Hex,
        },
        contractAddress: event.log.address as Hex,
        blockTimestamp: event.block.timestamp,
      },
    );
  },
);

// -----------------------------------------------------------------------------
// AccountMetadata (Base only)
// -----------------------------------------------------------------------------

ponder.on(
  "efp/AccountMetadata:UpdateAccountMetadata",
  async ({ context, event }) => {
    await handleUpdateAccountMetadata(
      createPonderEFPStore(context.db as never),
      {
        args: {
          addr: event.args.addr as Hex,
          key: event.args.key,
          value: event.args.value as Hex,
        },
        chainId: context.chain!.id,
        contractAddress: event.log.address as Hex,
        blockTimestamp: event.block.timestamp,
      },
    );
  },
);

// -----------------------------------------------------------------------------
// ListRecords (Base, Optimism, Ethereum)
// -----------------------------------------------------------------------------

ponder.on("efp/ListRecords:ListOp", async ({ context, event }) => {
  await handleListOp(createPonderEFPStore(context.db as never), {
    args: {
      slot: event.args.slot,
      op: event.args.op as Hex,
    },
    chainId: context.chain!.id,
    contractAddress: event.log.address as Hex,
    blockTimestamp: event.block.timestamp,
  });
});

ponder.on(
  "efp/ListRecords:UpdateListMetadata",
  async ({ context, event }) => {
    await handleUpdateListMetadata(createPonderEFPStore(context.db as never), {
      args: {
        slot: event.args.slot,
        key: event.args.key,
        value: event.args.value as Hex,
      },
      chainId: context.chain!.id,
      contractAddress: event.log.address as Hex,
      blockTimestamp: event.block.timestamp,
    });
  },
);

// -----------------------------------------------------------------------------
// Resolver (Ethereum mainnet, pre-filtered by indexedKey)
// -----------------------------------------------------------------------------

ponder.on("efp/Resolver:TextChanged", async ({ context, event }) => {
  await handleResolverTextChanged(createPonderEFPStore(context.db as never), {
    args: {
      node: event.args.node as Hex,
      key: event.args.key,
      value: event.args.value,
    },
    chainId: context.chain!.id,
    contractAddress: event.log.address as Hex,
    blockTimestamp: event.block.timestamp,
  });
});
