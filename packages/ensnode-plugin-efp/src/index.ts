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
  computeOfflineUrlHash,
  encodeOfflineListStorageLocation,
  LOCATION_TYPE,
  LIST_STORAGE_LOCATION_ONCHAIN_LENGTH,
  LIST_STORAGE_LOCATION_OFFLINE_MIN_LENGTH,
  LIST_STORAGE_LOCATION_LENGTH,
  type ParsedListStorageLocation,
  type OnchainListStorageLocation,
  type OfflineListStorageLocation,
} from "./lib/parse-list-storage-location.js";
export {
  OFFLINE_CHAIN_ID,
  OFFLINE_CONTRACT_ADDRESS,
  offlineSlot,
} from "./lib/offline-slot.js";
export * as efpSchema from "./schema.js";

export {
  parseOfflinePayload,
  offlineRecordToWireFormat,
  PayloadValidationError,
  MAX_PAYLOAD_BYTES,
  type OfflineListPayload,
  type OfflineRecord,
  type OfflineMetadata,
} from "./offline/payload.js";

export {
  OfflineListSyncer,
  type OfflineListSyncerOptions,
  type SyncOutcome,
  type SyncerEvent,
} from "./offline/syncer.js";

export {
  handleTransfer,
  handleUpdateListStorageLocation,
} from "./handlers/ListRegistry.js";
export { handleUpdateAccountMetadata } from "./handlers/AccountMetadata.js";
export {
  handleListOp,
  handleUpdateListMetadata,
} from "./handlers/ListRecords.js";
export {
  createPonderEFPStore,
  type PonderStoreLikeDb,
} from "./handlers/ponder-store.js";
export {
  type EFPStore,
  type EFPListRow,
  type EFPListRecordRow,
  type EFPListRecordTagRow,
  type EFPAccountMetadataRow,
  type EFPPendingListMetadataRow,
  type EFPOfflineListRow,
  type EFPOfflineSyncUpdate,
  type EFPEnsListPointerRow,
  type PendingListMetadataLookup,
  listRecordId,
  listRecordTagId,
  accountMetadataId,
  pendingListMetadataId,
  ensListPointerId,
} from "./handlers/store.js";
