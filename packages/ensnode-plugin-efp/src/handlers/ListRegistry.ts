/**
 * EFP `ListRegistry` event handlers.
 *
 * - `Transfer(from, to, tokenId)` mints/transfers a list NFT. The handler
 *   upserts the list row keyed by `tokenId` with the new owner.
 * - `UpdateListStorageLocation(tokenId, listStorageLocation)` (re-)points a
 *   list at the chain/contract/slot where its records live. The handler
 *   parses the 86-byte payload and writes the decoded fields onto the list
 *   row, then drains any pending list metadata that was staged while we did
 *   not yet know which list NFT this storage location belonged to.
 *
 * Both handlers are written as pure functions over an `EFPStore`. The
 * ENSIndexer-side `event-handlers.ts` (and the standalone Ponder example)
 * adapt these into Ponder event listeners by constructing an `EFPStore`
 * around `context.ensDb` / `context.db`.
 */

import type { Hex } from "viem";

import { parseListStorageLocation } from "../lib/parse-list-storage-location.js";
import type { EFPStore, PendingListMetadataLookup } from "./store.js";

export interface TransferArgs {
  from: Hex;
  to: Hex;
  tokenId: bigint;
}

export interface UpdateListStorageLocationArgs {
  tokenId: bigint;
  listStorageLocation: Hex;
}

export interface HandlerEnvelope<TArgs> {
  args: TArgs;
  contractAddress: Hex;
  /** Block timestamp in seconds. */
  blockTimestamp: bigint;
}

export async function handleTransfer(
  store: EFPStore,
  { args, contractAddress, blockTimestamp }: HandlerEnvelope<TransferArgs>,
): Promise<void> {
  const ts = new Date(Number(blockTimestamp) * 1000);
  await store.upsertList({
    token_id: args.tokenId.toString(),
    owner: args.to.toLowerCase() as Hex,
    nft_chain_id: 8453,
    nft_contract_address: contractAddress.toLowerCase() as Hex,
    created_at: ts,
    updated_at: ts,
  });
}

export async function handleUpdateListStorageLocation(
  store: EFPStore,
  { args, blockTimestamp }: HandlerEnvelope<UpdateListStorageLocationArgs>,
): Promise<void> {
  const parsed = parseListStorageLocation(args.listStorageLocation);
  if (!parsed) return;

  const ts = new Date(Number(blockTimestamp) * 1000);

  await store.setListStorageLocation(args.tokenId.toString(), {
    list_storage_location: args.listStorageLocation,
    list_storage_location_chain_id: Number(parsed.chainId),
    list_storage_location_contract_address: parsed.contractAddress,
    list_storage_location_slot: parsed.slot,
    updated_at: ts,
  });

  // Drain any pending list metadata that was staged for this exact
  // (chainId, contract, slot) tuple.
  const lookup: PendingListMetadataLookup = {
    chain_id: Number(parsed.chainId),
    contract_address: parsed.contractAddress,
    slot: parsed.slot,
  };
  const pending = await store.drainPendingListMetadata(lookup);

  for (const { key, value } of pending) {
    // Both well-known keys carry a 20-byte address as their value.
    const address = ("0x" + value.slice(2, 42).toLowerCase()) as Hex;

    if (key === "user") {
      await store.setListUserBySlot(lookup, address, ts);
    } else if (key === "manager") {
      await store.setListManagerBySlot(lookup, address, ts);
    }
  }
}
