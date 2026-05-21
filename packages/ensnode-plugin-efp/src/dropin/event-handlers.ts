/**
 * ENSIndexer event-handlers entry-point for EFP.
 *
 * This file is a *drop-in template* — see `./plugin.ts` for the integration
 * checklist. It imports `@/lib/indexing-engines/ponder` which only resolves
 * inside an ENSNode checkout.
 *
 * Once installed, ENSIndexer's `register-handlers.ts` calls the default
 * export of this file when the EFP plugin is in `PLUGINS`.
 */

import type { Hex } from "viem";

// @ts-expect-error: ENSNode-only path alias.
import { addOnchainEventListener } from "@/lib/indexing-engines/ponder";
// @ts-expect-error: ENSNode-only path alias.
import { namespaceContract } from "@/lib/plugin-helpers";
// @ts-expect-error: ENSNode-only path alias.
import { PluginName } from "@ensnode/ensnode-sdk";

import {
  handleTransfer,
  handleUpdateListStorageLocation,
} from "../handlers/ListRegistry.js";
import { handleUpdateAccountMetadata } from "../handlers/AccountMetadata.js";
import {
  handleListOp,
  handleUpdateListMetadata,
} from "../handlers/ListRecords.js";
import { createPonderEFPStore } from "../handlers/ponder-store.js";

export default function attachEFPHandlers(): void {
  const pluginName = (PluginName as unknown as { EFP: "efp" }).EFP;

  // ListRegistry — Base only
  addOnchainEventListener(
    namespaceContract(pluginName, "ListRegistry:Transfer"),
    async ({ context, event }: any) => {
      await handleTransfer(createPonderEFPStore(context.ensDb), {
        args: {
          from: event.args.from as Hex,
          to: event.args.to as Hex,
          tokenId: event.args.tokenId as bigint,
        },
        contractAddress: event.log.address as Hex,
        blockTimestamp: event.block.timestamp as bigint,
      });
    },
  );

  addOnchainEventListener(
    namespaceContract(pluginName, "ListRegistry:UpdateListStorageLocation"),
    async ({ context, event }: any) => {
      await handleUpdateListStorageLocation(createPonderEFPStore(context.ensDb), {
        args: {
          tokenId: event.args.tokenId as bigint,
          listStorageLocation: event.args.listStorageLocation as Hex,
        },
        contractAddress: event.log.address as Hex,
        blockTimestamp: event.block.timestamp as bigint,
      });
    },
  );

  // AccountMetadata — Base only
  addOnchainEventListener(
    namespaceContract(pluginName, "AccountMetadata:UpdateAccountMetadata"),
    async ({ context, event }: any) => {
      await handleUpdateAccountMetadata(createPonderEFPStore(context.ensDb), {
        args: {
          addr: event.args.addr as Hex,
          key: event.args.key as string,
          value: event.args.value as Hex,
        },
        chainId: context.chain.id as number,
        contractAddress: event.log.address as Hex,
        blockTimestamp: event.block.timestamp as bigint,
      });
    },
  );

  // ListRecords — Base, Optimism, Ethereum
  addOnchainEventListener(
    namespaceContract(pluginName, "ListRecords:ListOp"),
    async ({ context, event }: any) => {
      await handleListOp(createPonderEFPStore(context.ensDb), {
        args: {
          slot: event.args.slot as bigint,
          op: event.args.op as Hex,
        },
        chainId: context.chain.id as number,
        contractAddress: event.log.address as Hex,
        blockTimestamp: event.block.timestamp as bigint,
      });
    },
  );

  addOnchainEventListener(
    namespaceContract(pluginName, "ListRecords:UpdateListMetadata"),
    async ({ context, event }: any) => {
      await handleUpdateListMetadata(createPonderEFPStore(context.ensDb), {
        args: {
          slot: event.args.slot as bigint,
          key: event.args.key as string,
          value: event.args.value as Hex,
        },
        chainId: context.chain.id as number,
        contractAddress: event.log.address as Hex,
        blockTimestamp: event.block.timestamp as bigint,
      });
    },
  );
}
