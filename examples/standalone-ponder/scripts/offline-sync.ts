/**
 * Run the OfflineListSyncer against the standalone PGlite database that
 * `ponder dev` populates. This script is intended to be run alongside
 * `ponder dev` (in a second terminal) so that any list NFTs whose
 * UpdateListStorageLocation payload decoded to `locationType=2` get their
 * records pulled from their URL on an interval.
 *
 * In a production ENSIndexer deployment, the syncer would be wired up as a
 * sidecar process by the operator — see
 * `packages/ensnode-plugin-efp/src/offline/syncer.ts`. The standalone
 * harness reaches into Ponder's PGlite directly via the `@electric-sql/pglite`
 * driver because Ponder doesn't expose its `db.sql` outside the indexing
 * runtime.
 *
 * Usage:
 *
 *   pnpm exec tsx scripts/offline-sync.ts                    # one batch, then exit
 *   pnpm exec tsx scripts/offline-sync.ts --watch            # loop, default cadence
 *   pnpm exec tsx scripts/offline-sync.ts --watch --cadence-ms=30000
 *   pnpm exec tsx scripts/offline-sync.ts --schema=ponder_efp_smoke
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import {
  OfflineListSyncer,
  type EFPEnsListPointerRow,
  type EFPListRecordRow,
  type EFPListRecordTagRow,
  type EFPOfflineListRow,
  type EFPStore,
  ensListPointerId,
} from "@efpnode/ensnode-plugin-efp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pgliteDir = path.resolve(__dirname, "../.ponder/pglite");

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.find((a) => a.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

const schema = arg("schema") ?? "ponder_efp_smoke";
const cadenceMs = Number(arg("cadence-ms") ?? "60000");
const watch = process.argv.includes("--watch");

async function main() {
  const db = new PGlite(pgliteDir);
  const store = makePGliteStore(db, schema);
  const syncer = new OfflineListSyncer({
    store,
    logger: (e) => {
      // Print json so the operator can pipe it to jq.
      console.log(JSON.stringify({ ts: new Date().toISOString(), ...e }));
    },
    // Sane standalone defaults — production should tune these.
    successDelayMs: 10 * 60_000,
  });

  if (watch) {
    const stop = syncer.start(cadenceMs);
    process.on("SIGINT", () => {
      stop();
      db.close().finally(() => process.exit(0));
    });
    // Block forever.
    await new Promise(() => undefined);
  } else {
    const outcomes = await syncer.runOnce();
    console.log(JSON.stringify({ ts: new Date().toISOString(), outcomes }, null, 2));
    await db.close();
  }
}

/**
 * Minimal `EFPStore` adapter over a PGlite client. We only implement the
 * methods the syncer actually uses (offline-list + reconcile + metadata),
 * and `throw` from the others so a misuse fails loudly rather than
 * silently no-opping.
 */
function makePGliteStore(db: PGlite, schema: string): EFPStore {
  const q = (table: string) => `${schema}.${table}`;
  const notImplemented = (name: string) => () => {
    throw new Error(`pglite EFPStore: ${name}() is only available in the indexer process`);
  };

  return {
    upsertList: notImplemented("upsertList"),
    setListStorageLocation: notImplemented("setListStorageLocation"),
    insertRecord: notImplemented("insertRecord"),
    deleteRecord: notImplemented("deleteRecord"),
    insertTag: notImplemented("insertTag"),
    deleteTag: notImplemented("deleteTag"),
    upsertAccountMetadata: notImplemented("upsertAccountMetadata"),
    upsertPendingListMetadata: notImplemented("upsertPendingListMetadata"),
    drainPendingListMetadata: notImplemented("drainPendingListMetadata"),
    upsertOfflineList: notImplemented("upsertOfflineList"),
    deleteOfflineList: notImplemented("deleteOfflineList"),
    upsertEnsListPointer: notImplemented("upsertEnsListPointer") as unknown as (
      row: EFPEnsListPointerRow,
    ) => Promise<void>,
    deleteEnsListPointer: notImplemented("deleteEnsListPointer"),

    async setListUserBySlot(lookup, user, updated_at) {
      const r = await db.query(
        `update ${q("efp_lists")}
           set "user" = $1, updated_at = $2
         where list_storage_location_chain_id = $3
           and list_storage_location_contract_address = $4
           and list_storage_location_slot = $5
         returning token_id`,
        [user, updated_at, lookup.chain_id, lookup.contract_address.toLowerCase(), lookup.slot.toLowerCase()],
      );
      return r.rows.length > 0;
    },

    async setListManagerBySlot(lookup, manager, updated_at) {
      const r = await db.query(
        `update ${q("efp_lists")}
           set manager = $1, updated_at = $2
         where list_storage_location_chain_id = $3
           and list_storage_location_contract_address = $4
           and list_storage_location_slot = $5
         returning token_id`,
        [manager, updated_at, lookup.chain_id, lookup.contract_address.toLowerCase(), lookup.slot.toLowerCase()],
      );
      return r.rows.length > 0;
    },

    async listDueOfflineLists(now, limit) {
      const r = (await db.query(
        `select token_id, url, url_hash, chain_id_hint, etag, last_modified,
                last_synced_at, last_synced_status, next_sync_at,
                consecutive_failures, created_at, updated_at
           from ${q("efp_offline_lists")}
          where next_sync_at is null or next_sync_at <= $1
          order by next_sync_at asc nulls first
          limit $2`,
        [now, limit],
      )) as { rows: any[] };
      return r.rows.map((row) => ({
        token_id: row.token_id,
        url: row.url,
        url_hash: row.url_hash,
        chain_id_hint: row.chain_id_hint,
        etag: row.etag,
        last_modified: row.last_modified,
        last_synced_at: row.last_synced_at ? new Date(row.last_synced_at) : null,
        last_synced_status: row.last_synced_status,
        next_sync_at: row.next_sync_at ? new Date(row.next_sync_at) : null,
        consecutive_failures: row.consecutive_failures,
        created_at: new Date(row.created_at),
        updated_at: new Date(row.updated_at),
      })) as EFPOfflineListRow[];
    },

    async updateOfflineSyncStatus(token_id, update) {
      await db.query(
        `update ${q("efp_offline_lists")}
            set etag = $1, last_modified = $2, last_synced_at = $3,
                last_synced_status = $4, next_sync_at = $5,
                consecutive_failures = $6, updated_at = $3
          where token_id = $7`,
        [
          update.etag ?? null,
          update.last_modified ?? null,
          update.last_synced_at,
          update.last_synced_status,
          update.next_sync_at,
          update.consecutive_failures,
          token_id,
        ],
      );
    },

    async reconcileOfflineRecords(input) {
      const params = [
        input.chain_id,
        input.contract_address.toLowerCase(),
        input.slot.toLowerCase(),
      ];
      await db.query(
        `delete from ${q("efp_list_records")}
          where chain_id = $1 and contract_address = $2 and slot = $3`,
        params,
      );
      await db.query(
        `delete from ${q("efp_list_record_tags")}
          where chain_id = $1 and contract_address = $2 and slot = $3`,
        params,
      );
      for (const row of input.records) {
        await insertRecord(db, schema, row);
      }
      for (const row of input.tags) {
        await insertTag(db, schema, row);
      }
    },
  };
}

async function insertRecord(db: PGlite, schema: string, row: EFPListRecordRow) {
  await db.query(
    `insert into ${schema}.efp_list_records
       (id, chain_id, contract_address, slot, record,
        record_version, record_type, record_data, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (id) do nothing`,
    [
      row.id,
      row.chain_id,
      row.contract_address,
      row.slot,
      row.record,
      row.record_version,
      row.record_type,
      row.record_data,
      row.created_at,
    ],
  );
}

async function insertTag(db: PGlite, schema: string, row: EFPListRecordTagRow) {
  await db.query(
    `insert into ${schema}.efp_list_record_tags
       (id, chain_id, contract_address, slot, record, tag, created_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (id) do nothing`,
    [
      row.id,
      row.chain_id,
      row.contract_address,
      row.slot,
      row.record,
      row.tag,
      row.created_at,
    ],
  );
}

// keep references so tree-shaking doesn't remove them when they're imported
// in the unused notImplemented branch
void ensListPointerId;

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
