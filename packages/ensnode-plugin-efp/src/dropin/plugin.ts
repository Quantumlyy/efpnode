/**
 * ENSIndexer plugin definition for EFP.
 *
 * This file is a *drop-in template*: it imports modules that only exist
 * inside an ENSNode checkout (`@ensnode/ensnode-sdk`, `@/lib/plugin-helpers`,
 * `@/lib/ponder-helpers`, `ponder`). When copied to
 * `apps/ensindexer/src/plugins/efp/plugin.ts` it compiles unchanged.
 *
 * To consume this plugin you must additionally:
 *
 *  1. Add `EFP = "efp"` to the `PluginName` enum at
 *     `packages/ensnode-sdk/src/ensindexer/config/types.ts`.
 *  2. Copy `src/schema.ts` into
 *     `packages/ensdb-sdk/src/ensindexer-abstract/efp.schema.ts` and
 *     re-export it from the abstract schema's `index.ts`.
 *  3. Register this plugin's default export in `ALL_PLUGINS`
 *     (`apps/ensindexer/src/plugins/index.ts`).
 *  4. Wire `event-handlers.ts` in
 *     `apps/ensindexer/ponder/src/register-handlers.ts`, guarded by
 *     `config.plugins.includes(PluginName.EFP)`.
 *
 * EFP does not interact with the ENS protocol, so this plugin declares no
 * `requiredDatasourceNames` and builds its chain config from
 * `config.rpcConfigs` directly. It will only activate on the `mainnet`
 * namespace because EFP has no Sepolia / devnet deployment today.
 */

// @ts-expect-error: this module only exists inside an ENSNode checkout.
import { createConfig } from "ponder";

// @ts-expect-error: ENSNode-only path alias.
import { PluginName } from "@ensnode/ensnode-sdk";
// @ts-expect-error: ENSNode-only path alias.
import { createPlugin, namespaceContract } from "@/lib/plugin-helpers";
// @ts-expect-error: ENSNode-only path alias.
import { chainsConnectionConfig } from "@/lib/ponder-helpers";

import {
  AccountMetadataABI,
  ListRecordsABI,
  ListRegistryABI,
} from "../abis.js";
import { EFP_CONTRACTS, EFP_PLUGIN_NAME } from "../constants.js";

// In an ENSNode checkout, this resolves to PluginName.EFP after step (1).
const pluginName = (PluginName as unknown as { EFP: typeof EFP_PLUGIN_NAME }).EFP;

export default createPlugin({
  name: pluginName,
  // EFP doesn't reuse ENS contracts; no datasource gating.
  requiredDatasourceNames: [] as const,
  allDatasourceNames: [] as const,
  createPonderConfig(config: any) {
    // Only mainnet has EFP deployed today.
    if (config.namespace !== "mainnet") {
      throw new Error(
        `[ensnode-plugin-efp] EFP plugin only supports the 'mainnet' ENS namespace; got '${config.namespace}'`,
      );
    }

    const base = EFP_CONTRACTS.ListRecords.base;
    const optimism = EFP_CONTRACTS.ListRecords.optimism;
    const ethereum = EFP_CONTRACTS.ListRecords.ethereum;
    const registry = EFP_CONTRACTS.ListRegistry;
    const accountMetadata = EFP_CONTRACTS.AccountMetadata;

    return createConfig({
      chains: {
        ...chainsConnectionConfig(config.rpcConfigs, base.chainId),
        ...chainsConnectionConfig(config.rpcConfigs, optimism.chainId),
        ...chainsConnectionConfig(config.rpcConfigs, ethereum.chainId),
      },
      contracts: {
        [namespaceContract(pluginName, "ListRegistry")]: {
          chain: {
            [chainKey(base.chainId)]: {
              address: registry.address,
              startBlock: registry.startBlock,
            },
          },
          abi: ListRegistryABI,
        },
        [namespaceContract(pluginName, "AccountMetadata")]: {
          chain: {
            [chainKey(base.chainId)]: {
              address: accountMetadata.address,
              startBlock: accountMetadata.startBlock,
            },
          },
          abi: AccountMetadataABI,
        },
        // Multi-chain: same ABI, three deployments.
        [namespaceContract(pluginName, "ListRecords")]: {
          chain: {
            [chainKey(base.chainId)]: {
              address: base.address,
              startBlock: base.startBlock,
            },
            [chainKey(optimism.chainId)]: {
              address: optimism.address,
              startBlock: optimism.startBlock,
            },
            [chainKey(ethereum.chainId)]: {
              address: ethereum.address,
              startBlock: ethereum.startBlock,
            },
          },
          abi: ListRecordsABI,
        },
      },
    });
  },
});

/**
 * Ponder uses the ENS namespace string keys returned by `chainsConnectionConfig`
 * for its `chain` map. We need to mirror them here without re-implementing the
 * full mapping; ENSIndexer's `chainsConnectionConfig` keys chains by their
 * viem chain `name` (e.g. "mainnet", "base", "optimism"). We use the short
 * form that's stable across viem versions.
 */
function chainKey(chainId: number): string {
  switch (chainId) {
    case 1:
      return "mainnet";
    case 10:
      return "optimism";
    case 8453:
      return "base";
    default:
      throw new Error(`[ensnode-plugin-efp] Unsupported chain id ${chainId}`);
  }
}
