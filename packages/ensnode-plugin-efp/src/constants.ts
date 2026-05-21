/**
 * Onchain coordinates for the Ethereum Follow Protocol.
 *
 * Source of truth (cross-checked):
 *   - https://docs.efp.app
 *   - ethereumfollowprotocol/api-v2 services/shared/src/config/index.ts
 *   - ethereumfollowprotocol/api-v2 services/indexer/src/index.ts (start blocks)
 *
 * The EFP `ListRegistry` and `AccountMetadata` contracts are deployed only on
 * Base. The `ListRecords` contract is deployed on Base, Optimism, and Ethereum
 * mainnet (these are the "list storage location" chains that a list NFT can
 * point at via its `UpdateListStorageLocation` payload).
 */

import type { Hex } from "viem";

export const EFP_PLUGIN_NAME = "efp" as const;
export type EFPPluginName = typeof EFP_PLUGIN_NAME;

export interface EFPContractCoordinates {
  chainId: number;
  address: Hex;
  startBlock: number;
}

export const EFP_CONTRACTS = {
  ListRegistry: {
    chainId: 8453,
    address: "0x0E688f5DCa4a0a4729946ACbC44C792341714e08",
    startBlock: 20_180_000,
  },
  AccountMetadata: {
    chainId: 8453,
    address: "0x5289fE5daBC021D02FDDf23d4a4DF96F4E0F17EF",
    startBlock: 20_180_000,
  },
  ListRecords: {
    base: {
      chainId: 8453,
      address: "0x41Aa48Ef3c0446b46a5b1cc6337FF3d3716E2A33",
      startBlock: 20_180_000,
    },
    optimism: {
      chainId: 10,
      address: "0x4Ca00413d850DcFa3516E14d21DAE2772F2aCb85",
      startBlock: 125_792_000,
    },
    ethereum: {
      chainId: 1,
      address: "0x5289fE5daBC021D02FDDf23d4a4DF96F4E0F17EF",
      startBlock: 20_820_000,
    },
  },
} as const satisfies {
  ListRegistry: EFPContractCoordinates;
  AccountMetadata: EFPContractCoordinates;
  ListRecords: Record<"base" | "optimism" | "ethereum", EFPContractCoordinates>;
};

export const EFP_LIST_RECORDS_CHAINS = ["base", "optimism", "ethereum"] as const;
export type EFPListRecordsChain = (typeof EFP_LIST_RECORDS_CHAINS)[number];

/**
 * EFP ListOp opcodes (version 0x01).
 *
 * Encoded as `version (1) | opcode (1) | data (variable)` inside a `ListOp.op`
 * payload. We mirror the api-v2 reference implementation.
 */
export const EFP_OPCODE = {
  ADD_RECORD: 0x01,
  REMOVE_RECORD: 0x02,
  ADD_TAG: 0x03,
  REMOVE_TAG: 0x04,
} as const;

/**
 * EFP record types (version 0x01).
 *
 * - 1: 20-byte address (the only record type EFP currently uses in production).
 *   The api-v2 indexer truncates `recordData` to 20 bytes for this type because
 *   some users have appended junk after the address.
 */
export const EFP_RECORD_TYPE = {
  ADDRESS: 0x01,
} as const;

/**
 * Well-known list-metadata keys produced by EFP contracts. Both values are
 * 20-byte addresses encoded as `bytes`.
 */
export const EFP_LIST_METADATA_KEYS = {
  USER: "user",
  MANAGER: "manager",
} as const;
