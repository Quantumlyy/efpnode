/**
 * EFP contract ABIs (event-only subsets).
 *
 * Mirrors `services/indexer/src/abis.ts` in ethereumfollowprotocol/api-v2 with two
 * deliberate differences:
 *
 *  - `ListOp.slot` and `UpdateListMetadata.slot` are declared as `uint256`
 *    (matching the live contracts), not `bytes32`. The standalone indexer
 *    zero-pads them post-decode to fit a `bytes32` column; we keep them as
 *    `uint256` and let event handlers do the conversion.
 *  - `UpdateAccountMetadata.value` and `UpdateListMetadata.value` are typed
 *    as `bytes` (not `string`); the contracts emit raw bytes for both, and
 *    most keys store binary payloads (e.g. a 20-byte address for the `user`
 *    and `manager` keys).
 */

export const ListRegistryABI = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { indexed: true, name: "from", type: "address" },
      { indexed: true, name: "to", type: "address" },
      { indexed: true, name: "tokenId", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "UpdateListStorageLocation",
    inputs: [
      { indexed: true, name: "tokenId", type: "uint256" },
      { indexed: false, name: "listStorageLocation", type: "bytes" },
    ],
  },
  {
    type: "event",
    name: "UpdateUser",
    inputs: [
      { indexed: true, name: "tokenId", type: "uint256" },
      { indexed: true, name: "user", type: "address" },
    ],
  },
  {
    type: "event",
    name: "UpdateManager",
    inputs: [
      { indexed: true, name: "tokenId", type: "uint256" },
      { indexed: true, name: "manager", type: "address" },
    ],
  },
] as const;

export const AccountMetadataABI = [
  {
    type: "event",
    name: "UpdateAccountMetadata",
    inputs: [
      { indexed: true, name: "addr", type: "address" },
      { indexed: false, name: "key", type: "string" },
      { indexed: false, name: "value", type: "bytes" },
    ],
  },
] as const;

export const ListRecordsABI = [
  {
    type: "event",
    name: "ListOp",
    inputs: [
      { indexed: true, name: "slot", type: "uint256" },
      { indexed: false, name: "op", type: "bytes" },
    ],
  },
  {
    type: "event",
    name: "UpdateListMetadata",
    inputs: [
      { indexed: true, name: "slot", type: "uint256" },
      { indexed: false, name: "key", type: "string" },
      { indexed: false, name: "value", type: "bytes" },
    ],
  },
] as const;

/**
 * Minimal ENS `Resolver` event-only ABI used by the EFP plugin to subscribe
 * to text-record updates for the `eth.efp.list` cross-correlation. This is
 * the standard ENS resolver `TextChanged(bytes32 indexed node, string
 * indexed indexedKey, string key, string value)` shape — identical to the
 * event in ENSNode's `ResolverABI` so the same handler dispatch works in
 * both contexts.
 *
 * We do not pin a contract address: every contract that emits this event
 * shape is fair game (matching how ENSNode's `subgraph` plugin watches all
 * resolvers).
 */
export const ResolverABI = [
  {
    type: "event",
    name: "TextChanged",
    inputs: [
      { indexed: true, name: "node", type: "bytes32" },
      { indexed: true, name: "indexedKey", type: "string" },
      { indexed: false, name: "key", type: "string" },
      { indexed: false, name: "value", type: "string" },
    ],
  },
] as const;
