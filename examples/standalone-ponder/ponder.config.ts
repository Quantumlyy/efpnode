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
  DEFAULT_EFP_LIST_TEXT_RECORD_KEY,
  EFP_CONTRACTS,
  EFP_PLUGIN_NAME,
  ListRecordsABI,
  ListRegistryABI,
  ResolverABI,
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

const DEFAULT_RESOLVER_ADDRESS = "0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63"; // ENS PublicResolver

/**
 * Returns the resolver addresses to subscribe to on chain 1.
 *
 *   undefined → don't add the Resolver contract at all (operator opted out)
 *   string[] (≥1)   → use these addresses
 *
 * Env contract:
 *   PONDER_RESOLVER_ADDRESSES=""       → opt out
 *   PONDER_RESOLVER_ADDRESSES="0x..."  → comma-separated list
 *   unset                              → use DEFAULT_RESOLVER_ADDRESS
 */
function parseResolverAddresses(): `0x${string}`[] | undefined {
  const raw = process.env.PONDER_RESOLVER_ADDRESSES;
  if (raw === "") return undefined;
  const list = raw ? raw.split(",") : [DEFAULT_RESOLVER_ADDRESS];
  return list
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s as `0x${string}`);
}

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
    // Resolver: subscribe to TextChanged on a configurable set of resolver
    // addresses on Ethereum mainnet, pre-filtered by `indexedKey =
    // keccak256("eth.efp.list")` so we don't fetch the full TextChanged
    // firehose.
    //
    // We default to the canonical ENS PublicResolver because most public
    // RPCs (publicnode, ankr, …) refuse address-less eth_getLogs requests
    // even with a topic filter. Operators with a dedicated RPC may set
    // `PONDER_RESOLVER_ADDRESSES=` (comma-separated) to widen the scope or
    // empty to omit it entirely. Inside ENSIndexer (see `src/dropin/`) we
    // mirror ENSNode's resolver setup, which is address-less.
    ...(parseResolverAddresses() === undefined
      ? {}
      : {
          [ns("Resolver")]: {
            chain: {
              "1": {
                address: parseResolverAddresses()!,
                ...(smokeBlocks(1) ?? {
                  startBlock: EFP_CONTRACTS.ListRecords.ethereum.startBlock,
                }),
              },
            },
            abi: ResolverABI,
            filter: {
              event: "TextChanged",
              args: { indexedKey: DEFAULT_EFP_LIST_TEXT_RECORD_KEY },
            },
          },
        }),
  },
});
