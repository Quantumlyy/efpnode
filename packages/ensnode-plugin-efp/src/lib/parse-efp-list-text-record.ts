/**
 * Parser for the well-known ENS text-record `eth.efp.list`, which an ENS
 * owner can set on their resolver to declare which EFP list NFT belongs to
 * a given name.
 *
 * Two value formats are accepted:
 *
 *   1. Decimal token id        — `"1234"`
 *                                interpreted as a list on the default EFP
 *                                ListRegistry (chain 8453 / Base).
 *
 *   2. CAIP-19 asset identifier — `"eip155:8453/erc721:0x0E68...4e08/1234"`
 *                                explicit chain id, contract address, and
 *                                token id. The contract MUST resolve to the
 *                                EFP ListRegistry on `chainId` — the parser
 *                                does not enforce that here (a future EFP
 *                                deployment on another chain shouldn't need
 *                                a parser change), but the handler does.
 *
 * Returns `null` on any shape mismatch — the caller deletes the pointer in
 * that case (matching the ENS convention that "set to garbage" is the same
 * as "unset").
 */

import { isAddress, type Hex } from "viem";

import { EFP_CONTRACTS } from "../constants.js";

export interface ParsedEfpListPointer {
  listTokenId: string;
  /** EFP `ListRegistry` chain id. Defaults to 8453 (Base) for plain decimal values. */
  listChainId: number;
  /** EFP `ListRegistry` contract address, always lowercased. */
  listContract: Hex;
}

const DECIMAL_RE = /^[0-9]+$/;
const CAIP19_RE =
  /^eip155:(?<chainId>[0-9]+)\/erc721:(?<address>0x[0-9a-fA-F]{40})\/(?<tokenId>[0-9]+)$/;

const DEFAULT_LIST_REGISTRY = EFP_CONTRACTS.ListRegistry;

export function parseEfpListTextRecord(value: string): ParsedEfpListPointer | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (DECIMAL_RE.test(trimmed)) {
    return {
      listTokenId: trimmed,
      listChainId: DEFAULT_LIST_REGISTRY.chainId,
      listContract: DEFAULT_LIST_REGISTRY.address.toLowerCase() as Hex,
    };
  }

  const m = CAIP19_RE.exec(trimmed);
  if (!m?.groups) return null;
  const { chainId, address, tokenId } = m.groups;
  // We tolerate mixed-case addresses (no EIP-55 checksum enforcement) because
  // an ENS text record set by a user is often hand-edited and may not be
  // checksummed; the regex above already restricts it to 40 hex chars.
  if (!isAddress(address!, { strict: false })) return null;
  const parsedChainId = BigInt(chainId!);
  if (parsedChainId > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return {
    listTokenId: tokenId!,
    listChainId: Number(parsedChainId),
    listContract: address!.toLowerCase() as Hex,
  };
}

/**
 * The well-known ENS text-record key the plugin watches for. Exported so a
 * caller can pre-compute its keccak256 (used to filter `TextChanged` events
 * by their `indexedKey` topic) without re-implementing the constant.
 */
export const DEFAULT_EFP_LIST_TEXT_RECORD_KEY = "eth.efp.list";
