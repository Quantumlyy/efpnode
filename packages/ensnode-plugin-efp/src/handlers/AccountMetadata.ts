/**
 * EFP `AccountMetadata` event handler.
 *
 * `UpdateAccountMetadata(addr, key, value)` writes a single (key, value) pair
 * for an account. EFP currently uses one key — `primary-list` — but the
 * handler is generic.
 *
 * Mirrors `handleUpdateAccountMetadata` in api-v2 (services/indexer/src/handlers.ts).
 */

import type { Hex } from "viem";

import { accountMetadataId, type EFPStore } from "./store.js";

export interface UpdateAccountMetadataArgs {
  addr: Hex;
  key: string;
  value: Hex;
}

export interface HandlerEnvelope {
  args: UpdateAccountMetadataArgs;
  chainId: number;
  contractAddress: Hex;
  blockTimestamp: bigint;
}

export async function handleUpdateAccountMetadata(
  store: EFPStore,
  { args, chainId, contractAddress, blockTimestamp }: HandlerEnvelope,
): Promise<void> {
  const ts = new Date(Number(blockTimestamp) * 1000);
  const address = args.addr.toLowerCase() as Hex;

  await store.upsertAccountMetadata({
    id: accountMetadataId(address, args.key),
    chain_id: chainId,
    contract_address: contractAddress.toLowerCase() as Hex,
    address,
    key: args.key,
    value: args.value,
    created_at: ts,
    updated_at: ts,
  });
}
