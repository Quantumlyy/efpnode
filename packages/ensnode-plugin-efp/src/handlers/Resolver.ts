/**
 * EFP plugin handler for the ENS `Resolver.TextChanged` event.
 *
 * The plugin listens for text-record updates whose `key` equals the
 * well-known EFP key (default `eth.efp.list`) and stores the resulting
 * (resolver, node) → (list token id) cross-correlation in
 * `efp_ens_list_pointers`. Empty values delete the row, matching ENS's
 * "an empty text record is no record" convention.
 *
 * The on-the-wire event has its `indexedKey` topic indexed, so when the
 * plugin wires this handler into Ponder it does so with a filter on the
 * keccak256 of the configured key — `TextChanged` events for any other
 * key are never delivered to this handler.
 */

import type { Hex } from "viem";

import {
  DEFAULT_EFP_LIST_TEXT_RECORD_KEY,
  parseEfpListTextRecord,
} from "../lib/parse-efp-list-text-record.js";
import { ensListPointerId, type EFPStore } from "./store.js";

export interface ResolverTextChangedArgs {
  node: Hex;
  /** Plain `key` (string, not indexed). */
  key: string;
  /** Plain `value` (string, not indexed). */
  value: string;
}

export interface HandlerEnvelope {
  args: ResolverTextChangedArgs;
  chainId: number;
  /** Resolver contract address that emitted the event. */
  contractAddress: Hex;
  blockTimestamp: bigint;
  /** Override the well-known key the plugin matches. Defaults to `eth.efp.list`. */
  expectedKey?: string;
}

export async function handleResolverTextChanged(
  store: EFPStore,
  {
    args,
    chainId,
    contractAddress,
    blockTimestamp,
    expectedKey = DEFAULT_EFP_LIST_TEXT_RECORD_KEY,
  }: HandlerEnvelope,
): Promise<void> {
  // Defence-in-depth: Ponder is told to filter by `indexedKey == keccak256(expectedKey)`,
  // but operators may wire this handler up by hand without that filter, so
  // we recheck the unhashed `key` here too. Cheap.
  if (args.key !== expectedKey) return;

  const node = args.node.toLowerCase() as Hex;
  const resolver = contractAddress.toLowerCase() as Hex;
  const ts = new Date(Number(blockTimestamp) * 1000);

  if (!args.value) {
    await store.deleteEnsListPointer({ chain_id: chainId, resolver, node, ens_key: expectedKey });
    return;
  }

  const parsed = parseEfpListTextRecord(args.value);
  if (!parsed) {
    // Unparseable value — treat it as "clear the pointer" so consumers don't
    // see stale data after a bad write.
    await store.deleteEnsListPointer({ chain_id: chainId, resolver, node, ens_key: expectedKey });
    return;
  }

  await store.upsertEnsListPointer({
    id: ensListPointerId(chainId, resolver, node, expectedKey),
    chain_id: chainId,
    resolver,
    node,
    ens_key: expectedKey,
    raw_value: args.value,
    list_token_id: parsed.listTokenId,
    list_contract: parsed.listContract,
    list_chain_id: parsed.listChainId,
    created_at: ts,
    updated_at: ts,
  });
}
