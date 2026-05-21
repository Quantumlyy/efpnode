/**
 * Public re-exports for `@efpnode/ensnode-plugin-efp`.
 *
 * The intended consumer is the ENSIndexer process, which only needs the
 * default export from `./plugin` and `./event-handlers`. The rest are exposed
 * so the standalone Ponder harness in `examples/standalone-ponder/` and any
 * other tooling (or future Ponder-based EFP forks) can reuse the building
 * blocks directly.
 */

export { ListRegistryABI, AccountMetadataABI, ListRecordsABI } from "./abis.js";
export {
  EFP_PLUGIN_NAME,
  EFP_CONTRACTS,
  EFP_LIST_RECORDS_CHAINS,
  EFP_OPCODE,
  EFP_RECORD_TYPE,
  EFP_LIST_METADATA_KEYS,
  type EFPPluginName,
  type EFPContractCoordinates,
  type EFPListRecordsChain,
} from "./constants.js";
export {
  parseListOp,
  parseRecord,
  parseTagOp,
  extractTargetAddress,
  slotToBytes32,
  type ParsedListOp,
  type ParsedRecord,
  type ParsedTagOp,
} from "./lib/parse-list-op.js";
export {
  parseListStorageLocation,
  type ParsedListStorageLocation,
  LIST_STORAGE_LOCATION_LENGTH,
} from "./lib/parse-list-storage-location.js";
export * as efpSchema from "./schema.js";
