/**
 * Decoder for EFP `UpdateListStorageLocation.listStorageLocation` payloads.
 *
 * Two location types are recognised:
 *
 * ## `locationType == 1` (onchain, EVM)
 *
 * Original EFP encoding — records live in a contract on an EVM chain.
 *
 * ```
 *   version          (1 byte)
 *   locationType     (1 byte)  // == 0x01
 *   chainId          (32 bytes, big-endian uint256)
 *   contractAddress  (20 bytes)
 *   slot             (32 bytes)
 * ```
 *
 * Total: 86 bytes (172 hex chars + 2-char "0x" prefix).
 *
 * ## `locationType == 2` (offline, HTTPS) — extension shipped by this plugin
 *
 * Records live at an HTTP(S) URL, fetched periodically by the
 * `OfflineListSyncer`. The first four bytes are intentionally
 * shape-compatible with `locationType == 1` so a generic decoder can read
 * `version` and `locationType` before branching.
 *
 * ```
 *   version          (1 byte)
 *   locationType     (1 byte)  // == 0x02
 *   chainId          (32 bytes, big-endian uint256, 0 == chain-agnostic)
 *   urlHash          (32 bytes, keccak256(utf8(url)) — integrity anchor)
 *   url              (variable, UTF-8)
 * ```
 *
 * Total: 66 bytes + len(url) (≥ 134 hex chars + 2-char "0x" prefix).
 *
 * See `docs/RESEARCH.md` for the rationale (chainId == 0, urlHash, etc.).
 */

import { keccak256, stringToBytes, type Hex, isHex } from "viem";

export type ParsedListStorageLocation =
  | OnchainListStorageLocation
  | OfflineListStorageLocation;

export interface OnchainListStorageLocation {
  kind: "onchain";
  version: number;
  /** Raw locationType byte. Equal to `1` here for convenience. */
  locationType: 1;
  chainId: bigint;
  contractAddress: Hex;
  slot: Hex;
}

export interface OfflineListStorageLocation {
  kind: "offline";
  version: number;
  /** Raw locationType byte. Equal to `2` here for convenience. */
  locationType: 2;
  /** `0n` means "chain-agnostic"; non-zero is a "primary chain hint" for analytics. */
  chainId: bigint;
  /** keccak256(utf8(url)) committed onchain. Compare to keccak256(decoded url) at fetch time. */
  urlHash: Hex;
  /** Decoded URL string. Always UTF-8; not validated as a URL here. */
  url: string;
}

const HEX_BYTES = 2;
const HEADER_END = 2 * HEX_BYTES; // version + locationType
const CHAIN_END = HEADER_END + 32 * HEX_BYTES;

// locationType == 1 (onchain)
const ONCHAIN_ADDRESS_END = CHAIN_END + 20 * HEX_BYTES;
const ONCHAIN_SLOT_END = ONCHAIN_ADDRESS_END + 32 * HEX_BYTES;

// locationType == 2 (offline)
const OFFLINE_URL_HASH_END = CHAIN_END + 32 * HEX_BYTES;

/** Total length of a well-formed onchain payload in hex chars, including the "0x" prefix. */
export const LIST_STORAGE_LOCATION_ONCHAIN_LENGTH = ONCHAIN_SLOT_END + 2; // 174

/** Minimum length of a well-formed offline payload in hex chars, including "0x" and at least one URL byte. */
export const LIST_STORAGE_LOCATION_OFFLINE_MIN_LENGTH =
  OFFLINE_URL_HASH_END + 2 * HEX_BYTES + 2; // 138

/**
 * Backwards-compatible alias retained so consumers that imported this name
 * keep working. New code should use the more specific length constants above.
 *
 * @deprecated Use `LIST_STORAGE_LOCATION_ONCHAIN_LENGTH` instead.
 */
export const LIST_STORAGE_LOCATION_LENGTH = LIST_STORAGE_LOCATION_ONCHAIN_LENGTH;

export const LOCATION_TYPE = {
  ONCHAIN: 1,
  OFFLINE: 2,
} as const;

export function parseListStorageLocation(
  lsl: Hex | string | null | undefined,
): ParsedListStorageLocation | null {
  if (!lsl || typeof lsl !== "string" || !isHex(lsl)) return null;
  if (lsl.length < HEADER_END + 2) return null; // need at least version + locationType

  const bytes = lsl.slice(2);
  const version = parseInt(bytes.slice(0, HEADER_END / 2), 16);
  const locationType = parseInt(bytes.slice(HEADER_END / 2, HEADER_END), 16);

  switch (locationType) {
    case LOCATION_TYPE.ONCHAIN:
      return parseOnchain(bytes, version);
    case LOCATION_TYPE.OFFLINE:
      return parseOffline(bytes, version);
    default:
      return null;
  }
}

function parseOnchain(bytes: string, version: number): OnchainListStorageLocation | null {
  if (bytes.length < ONCHAIN_SLOT_END) return null;
  return {
    kind: "onchain",
    version,
    locationType: 1,
    chainId: BigInt("0x" + bytes.slice(HEADER_END, CHAIN_END)),
    contractAddress: ("0x" + bytes.slice(CHAIN_END, ONCHAIN_ADDRESS_END).toLowerCase()) as Hex,
    slot: ("0x" + bytes.slice(ONCHAIN_ADDRESS_END, ONCHAIN_SLOT_END)) as Hex,
  };
}

function parseOffline(bytes: string, version: number): OfflineListStorageLocation | null {
  if (bytes.length < OFFLINE_URL_HASH_END + 2) return null; // need at least 1 URL byte

  const urlHashHex = bytes.slice(CHAIN_END, OFFLINE_URL_HASH_END);
  const urlBytesHex = bytes.slice(OFFLINE_URL_HASH_END);
  if (urlBytesHex.length % 2 !== 0) return null;

  const url = hexToUtf8(urlBytesHex);

  return {
    kind: "offline",
    version,
    locationType: 2,
    chainId: BigInt("0x" + bytes.slice(HEADER_END, CHAIN_END)),
    urlHash: ("0x" + urlHashHex) as Hex,
    url,
  };
}

/**
 * Compute the `urlHash` for an offline LSL: `keccak256(utf8(url))`.
 *
 * Exposed so callers (e.g. payload validators, test harnesses) can recompute
 * the digest without re-parsing the LSL. The implementation uses viem so it
 * works identically in the browser, Bun, Deno, and Node.
 */
export function computeOfflineUrlHash(url: string): Hex {
  return keccak256(stringToBytes(url));
}

/**
 * Encode an offline LSL payload from its parts. Useful for tests and CLI
 * helpers that want to publish a payload onchain. Production callers should
 * generate this from the contract's higher-level helpers rather than calling
 * this directly.
 */
export function encodeOfflineListStorageLocation(input: {
  version?: number;
  chainId?: bigint;
  url: string;
}): Hex {
  const version = input.version ?? 1;
  const chainId = input.chainId ?? 0n;
  const urlHash = computeOfflineUrlHash(input.url);

  const versionHex = version.toString(16).padStart(2, "0");
  const locationTypeHex = "02";
  const chainIdHex = chainId.toString(16).padStart(64, "0");
  const urlHashHex = urlHash.slice(2);
  const urlHex = utf8ToHex(input.url);

  return ("0x" + versionHex + locationTypeHex + chainIdHex + urlHashHex + urlHex) as Hex;
}

function hexToUtf8(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

function utf8ToHex(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}
