/**
 * EFP `ListRegistry` event handlers.
 *
 * - `Transfer(from, to, tokenId)` mints/transfers a list NFT. The handler
 *   upserts the list row keyed by `tokenId` with the new owner.
 * - `UpdateListStorageLocation(tokenId, listStorageLocation)` (re-)points a
 *   list at its record store. The handler:
 *     - parses the payload as either `locationType=1` (onchain) or
 *       `locationType=2` (offline / HTTPS — see `parse-list-storage-location.ts`),
 *     - writes the decoded fields onto the `efp_lists` row (using the
 *       deterministic offline slot for `locationType=2`),
 *     - inserts/refreshes a row in `efp_offline_lists` when the location is
 *       offline, or deletes any pre-existing offline row if the location is
 *       now onchain (a list that switched back),
 *     - drains any pending list metadata that was staged before we knew
 *       which list NFT owned this storage location.
 *
 * Both handlers are written as pure functions over an `EFPStore`. The
 * ENSIndexer-side `event-handlers.ts` (and the standalone Ponder example)
 * adapt these into Ponder event listeners by constructing an `EFPStore`
 * around `context.ensDb` / `context.db`.
 */

import type { Hex } from "viem";

import {
  OFFLINE_CHAIN_ID,
  OFFLINE_CONTRACT_ADDRESS,
  offlineSlot,
} from "../lib/offline-slot.js";
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

  // Compute the (chain_id, contract, slot) tuple to write onto efp_lists.
  let chain_id: number;
  let contract_address: Hex;
  let slot: Hex;

  if (parsed.kind === "onchain") {
    const parsedChainId = chainIdToNumber(parsed.chainId);
    if (parsedChainId === null) return;
    chain_id = parsedChainId;
    contract_address = parsed.contractAddress;
    slot = parsed.slot;
    // If the list previously had an offline LSL, clear that bookkeeping row;
    // the records under the offline slot remain (the syncer will not touch a
    // list it no longer knows about, and the operator can decide whether to
    // garbage-collect them).
    await store.deleteOfflineList(args.tokenId.toString());
  } else {
    // locationType === 2 (offline)
    chain_id = OFFLINE_CHAIN_ID;
    contract_address = OFFLINE_CONTRACT_ADDRESS;
    slot = offlineSlot(args.tokenId);

    await store.upsertOfflineList({
      token_id: args.tokenId.toString(),
      url: parsed.url,
      url_hash: parsed.urlHash,
      chain_id_hint: parsed.chainId === 0n ? null : parsed.chainId.toString(),
      // The syncer will pick it up immediately (next_sync_at = ts).
      etag: null,
      last_modified: null,
      last_synced_at: null,
      last_synced_status: null,
      next_sync_at: ts,
      consecutive_failures: 0,
      created_at: ts,
      updated_at: ts,
    });
  }

  await store.setListStorageLocation(args.tokenId.toString(), {
    list_storage_location: args.listStorageLocation,
    list_storage_location_chain_id: chain_id,
    list_storage_location_contract_address: contract_address,
    list_storage_location_slot: slot,
    updated_at: ts,
  });

  // Drain any pending list metadata that was staged for this exact
  // (chainId, contract, slot) tuple.
  const lookup: PendingListMetadataLookup = {
    chain_id,
    contract_address,
    slot,
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

function chainIdToNumber(chainId: bigint): number | null {
  if (chainId > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(chainId);
}
