/**
 * Standalone Ponder app that indexes EFP using `@efpnode/ensnode-plugin-efp`.
 *
 * Goal: prove the plugin's ABIs, contract coordinates, and event names line
 * up with Ponder's `createConfig` shape — i.e. when the same files land in an
 * ENSNode checkout, ENSIndexer will register the same handler keys
 * (`efp/ListRegistry:Transfer`, `efp/ListRecords:ListOp`, …) and Ponder will
 * be able to source the matching logs.
 *
 * Run with:
 *
 *   PONDER_RPC_URL_1=https://...  PONDER_RPC_URL_10=https://...  \
 *   PONDER_RPC_URL_8453=https://... pnpm --filter @efpnode/example-standalone-ponder dev
 *
 * The example uses only public, free RPC defaults so it boots offline-friendly
 * if you don't supply env vars; Ponder will still build, register handlers,
 * and only fail on the first network round-trip.
 */

import { createConfig } from "ponder";
import { http } from "viem";

import {
  AccountMetadataABI,
  EFP_CONTRACTS,
  EFP_PLUGIN_NAME,
  ListRecordsABI,
  ListRegistryABI,
} from "@efpnode/ensnode-plugin-efp";

const RPC_URL_1 = process.env.PONDER_RPC_URL_1 ?? "https://eth.llamarpc.com";
const RPC_URL_10 = process.env.PONDER_RPC_URL_10 ?? "https://mainnet.optimism.io";
const RPC_URL_8453 = process.env.PONDER_RPC_URL_8453 ?? "https://mainnet.base.org";

const ns = (contractName: string) => `${EFP_PLUGIN_NAME}/${contractName}` as const;

/**
 * `scripts/smoke-test.ts` invokes `ponder dev` after setting
 * `EFP_SMOKE_TEST=1` and `EFP_SMOKE_BLOCKS_<chainId>_{START,END}` env vars.
 * When that flag is on we narrow the indexing window for every contract to
 * those bounds, which keeps a full smoke run under a minute.
 */
const smoke = process.env.EFP_SMOKE_TEST === "1";
const smokeBlocks = (chainId: number) =>
  smoke
    ? {
        startBlock: Number(process.env[`EFP_SMOKE_BLOCKS_${chainId}_START`]),
        endBlock: Number(process.env[`EFP_SMOKE_BLOCKS_${chainId}_END`]),
      }
    : null;

export default createConfig({
  chains: {
    "1": { id: 1, rpc: http(RPC_URL_1) },
    "10": { id: 10, rpc: http(RPC_URL_10) },
    "8453": { id: 8453, rpc: http(RPC_URL_8453) },
  },
  contracts: {
    [ns("ListRegistry")]: {
      chain: {
        "8453": {
          address: EFP_CONTRACTS.ListRegistry.address,
          ...(smokeBlocks(8453) ?? {
            startBlock: EFP_CONTRACTS.ListRegistry.startBlock,
          }),
        },
      },
      abi: ListRegistryABI,
    },
    [ns("AccountMetadata")]: {
      chain: {
        "8453": {
          address: EFP_CONTRACTS.AccountMetadata.address,
          ...(smokeBlocks(8453) ?? {
            startBlock: EFP_CONTRACTS.AccountMetadata.startBlock,
          }),
        },
      },
      abi: AccountMetadataABI,
    },
    [ns("ListRecords")]: {
      chain: {
        "8453": {
          address: EFP_CONTRACTS.ListRecords.base.address,
          ...(smokeBlocks(8453) ?? {
            startBlock: EFP_CONTRACTS.ListRecords.base.startBlock,
          }),
        },
        "10": {
          address: EFP_CONTRACTS.ListRecords.optimism.address,
          ...(smokeBlocks(10) ?? {
            startBlock: EFP_CONTRACTS.ListRecords.optimism.startBlock,
          }),
        },
        "1": {
          address: EFP_CONTRACTS.ListRecords.ethereum.address,
          ...(smokeBlocks(1) ?? {
            startBlock: EFP_CONTRACTS.ListRecords.ethereum.startBlock,
          }),
        },
      },
      abi: ListRecordsABI,
    },
  },
});
