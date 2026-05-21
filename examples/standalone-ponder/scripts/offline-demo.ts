/**
 * End-to-end demo of the offline LSL → syncer → indexed records flow,
 * without depending on a real onchain LSL of locationType=2 (no such list
 * exists on mainnet today since we invented the format).
 *
 * What this does:
 *
 *   1. Open the standalone PGlite directory that `ponder dev` populated.
 *   2. Insert a synthetic `efp_offline_lists` row pointing at a tiny local
 *      HTTP server (started in-process by the script).
 *   3. Run `OfflineListSyncer.runOnce()` against that store with a real
 *      `fetch`, exercising the full happy path (URL hash recompute,
 *      conditional-GET headers, content-type / size guardrails, JSON
 *      validation, record reconciliation).
 *   4. Read back the rows that landed in `efp_list_records` to prove the
 *      data really made it through.
 *
 * Run with:
 *
 *   pnpm exec tsx scripts/offline-demo.ts
 */

import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import {
  computeOfflineUrlHash,
  offlineSlot,
  OFFLINE_CHAIN_ID,
  OFFLINE_CONTRACT_ADDRESS,
  OfflineListSyncer,
  type EFPStore,
} from "@efpnode/ensnode-plugin-efp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pgliteDir = path.resolve(__dirname, "../.ponder/pglite");
const SCHEMA = process.argv.find((a) => a.startsWith("--schema="))?.split("=")[1] ?? "ponder_efp_smoke";

const TOKEN_ID = "999999"; // unlikely to collide with a real EFP list

const PAYLOAD = {
  version: 1,
  tokenId: TOKEN_ID,
  records: [
    { version: 1, recordType: 1, data: "0x" + "aa".repeat(20), tags: ["close-friend"] },
    { version: 1, recordType: 1, data: "0x" + "bb".repeat(20) },
    { version: 1, recordType: 1, data: "0x" + "cc".repeat(20) },
  ],
  metadata: {
    user: "0x" + "11".repeat(20),
    manager: "0x" + "22".repeat(20),
  },
};

async function main() {
  // 1. Start the mock HTTP server.
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      etag: '"demo-etag"',
    });
    res.end(JSON.stringify(PAYLOAD));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  // The syncer enforces https. For demo purposes the syncer reads `url`
  // verbatim from the row we insert, so we control it directly. We use an
  // https-looking host string with the local port; since we override
  // `fetch`, the URL doesn't actually have to be reachable as https.
  const url = `https://127.0.0.1:${port}/efp/list/${TOKEN_ID}.json`;

  // Custom fetch that rewrites our fake https URL to the real http one.
  const fetchImpl: typeof fetch = (input, init) => {
    const realUrl = (typeof input === "string" ? input : (input as Request).url).replace(
      "https://",
      "http://",
    );
    return globalThis.fetch(realUrl, init);
  };

  // 2. Open the DB and ensure schema exists. The script assumes the
  // standalone example has been run at least once to migrate the tables.
  const db = new PGlite(pgliteDir);
  const tableExists = (await db.query(
    `select 1 from information_schema.tables where table_schema=$1 and table_name='efp_offline_lists' limit 1`,
    [SCHEMA],
  )) as { rows: unknown[] };
  if (tableExists.rows.length === 0) {
    console.error(
      `schema "${SCHEMA}" has no efp_offline_lists table. Run \`pnpm smoke\` first to create the tables.`,
    );
    process.exit(1);
  }

  // Ponder installs live_query / reorg triggers on every indexed table
  // that depend on Ponder runtime state (live_query_tables, reorg shadow
  // tables) which only exist while ponder dev is running. We're operating
  // on the DB out-of-band so drop those triggers — the demo is read +
  // simulate, not a real indexing path.
  for (const t of [
    "efp_lists",
    "efp_list_records",
    "efp_list_record_tags",
    "efp_account_metadata",
    "efp_pending_list_metadata",
    "efp_offline_lists",
    "efp_ens_list_pointers",
  ]) {
    await db.query(`drop trigger if exists live_query on ${SCHEMA}.${t}`);
    await db.query(`drop trigger if exists reorg on ${SCHEMA}.${t}`);
  }

  // First create the list NFT row (offline LSL would normally do this for us).
  const now = new Date();
  await db.query(
    `insert into ${SCHEMA}.efp_lists
       (token_id, owner, nft_chain_id, nft_contract_address,
        list_storage_location_chain_id, list_storage_location_contract_address,
        list_storage_location_slot, created_at, updated_at)
     values ($1, $2, 8453, $3, $4, $5, $6, $7, $7)
     on conflict (token_id) do nothing`,
    [
      TOKEN_ID,
      "0x" + "ee".repeat(20),
      "0x0e688f5dca4a0a4729946acbc44c792341714e08",
      OFFLINE_CHAIN_ID,
      OFFLINE_CONTRACT_ADDRESS,
      offlineSlot(BigInt(TOKEN_ID)),
      now,
    ],
  );

  // Then insert the offline-list bookkeeping row.
  await db.query(
    `insert into ${SCHEMA}.efp_offline_lists
       (token_id, url, url_hash, consecutive_failures, created_at, updated_at, next_sync_at)
     values ($1, $2, $3, 0, $4, $4, $4)
     on conflict (token_id) do update set
       url = excluded.url,
       url_hash = excluded.url_hash,
       next_sync_at = excluded.next_sync_at,
       consecutive_failures = 0,
       etag = null,
       last_modified = null`,
    [TOKEN_ID, url, computeOfflineUrlHash(url), now],
  );

  console.log(`seeded offline list token_id=${TOKEN_ID} url=${url}`);

  // 3. Run the syncer.
  const store = pgliteEFPStore(db, SCHEMA);
  const syncer = new OfflineListSyncer({
    store,
    fetch: fetchImpl,
    logger: (e) => console.log(JSON.stringify(e)),
    successDelayMs: 60_000,
  });
  const outcomes = await syncer.runOnce();
  console.log("outcomes:", JSON.stringify(outcomes, null, 2));

  // 4. Read back.
  const records = (await db.query(
    `select record_data from ${SCHEMA}.efp_list_records
      where chain_id=0 and contract_address=$1 and slot=$2`,
    [OFFLINE_CONTRACT_ADDRESS, offlineSlot(BigInt(TOKEN_ID))],
  )) as { rows: Array<{ record_data: string }> };
  const tags = (await db.query(
    `select tag from ${SCHEMA}.efp_list_record_tags
      where chain_id=0 and contract_address=$1 and slot=$2`,
    [OFFLINE_CONTRACT_ADDRESS, offlineSlot(BigInt(TOKEN_ID))],
  )) as { rows: Array<{ tag: string }> };
  const list = (await db.query(
    `select "user", manager from ${SCHEMA}.efp_lists where token_id=$1`,
    [TOKEN_ID],
  )) as { rows: Array<{ user: string; manager: string }> };

  console.log("indexed records:", records.rows);
  console.log("indexed tags:   ", tags.rows);
  console.log("list metadata:  ", list.rows);

  server.close();
  await db.close();
}

// Adapter copy from offline-sync.ts — kept inline so the demo script is
// self-contained.
function pgliteEFPStore(db: PGlite, schema: string): EFPStore {
  const q = (t: string) => `${schema}.${t}`;
  const notImpl = (n: string) => (() => {
    throw new Error(`pglite EFPStore: ${n}() not implemented in demo script`);
  }) as any;

  return {
    upsertList: notImpl("upsertList"),
    setListStorageLocation: notImpl("setListStorageLocation"),
    insertRecord: notImpl("insertRecord"),
    deleteRecord: notImpl("deleteRecord"),
    insertTag: notImpl("insertTag"),
    deleteTag: notImpl("deleteTag"),
    upsertAccountMetadata: notImpl("upsertAccountMetadata"),
    upsertPendingListMetadata: notImpl("upsertPendingListMetadata"),
    drainPendingListMetadata: notImpl("drainPendingListMetadata"),
    upsertOfflineList: notImpl("upsertOfflineList"),
    deleteOfflineList: notImpl("deleteOfflineList"),
    upsertEnsListPointer: notImpl("upsertEnsListPointer"),
    deleteEnsListPointer: notImpl("deleteEnsListPointer"),

    async setListUserBySlot(lookup, user, updated_at) {
      const r = await db.query(
        `update ${q("efp_lists")} set "user"=$1, updated_at=$2
          where list_storage_location_chain_id=$3
            and list_storage_location_contract_address=$4
            and list_storage_location_slot=$5 returning token_id`,
        [user, updated_at, lookup.chain_id, lookup.contract_address.toLowerCase(), lookup.slot.toLowerCase()],
      );
      return r.rows.length > 0;
    },
    async setListManagerBySlot(lookup, manager, updated_at) {
      const r = await db.query(
        `update ${q("efp_lists")} set manager=$1, updated_at=$2
          where list_storage_location_chain_id=$3
            and list_storage_location_contract_address=$4
            and list_storage_location_slot=$5 returning token_id`,
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
        ...row,
        last_synced_at: row.last_synced_at ? new Date(row.last_synced_at) : null,
        next_sync_at: row.next_sync_at ? new Date(row.next_sync_at) : null,
        created_at: new Date(row.created_at),
        updated_at: new Date(row.updated_at),
      }));
    },

    async updateOfflineSyncStatus(token_id, update) {
      await db.query(
        `update ${q("efp_offline_lists")}
            set etag=$1, last_modified=$2, last_synced_at=$3,
                last_synced_status=$4, next_sync_at=$5,
                consecutive_failures=$6, updated_at=$3
          where token_id=$7`,
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
      const p = [input.chain_id, input.contract_address.toLowerCase(), input.slot.toLowerCase()];
      await db.query(
        `delete from ${q("efp_list_records")}
          where chain_id=$1 and contract_address=$2 and slot=$3`,
        p,
      );
      await db.query(
        `delete from ${q("efp_list_record_tags")}
          where chain_id=$1 and contract_address=$2 and slot=$3`,
        p,
      );
      for (const r of input.records) {
        await db.query(
          `insert into ${q("efp_list_records")}
             (id, chain_id, contract_address, slot, record,
              record_version, record_type, record_data, created_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           on conflict (id) do nothing`,
          [r.id, r.chain_id, r.contract_address, r.slot, r.record, r.record_version, r.record_type, r.record_data, r.created_at],
        );
      }
      for (const t of input.tags) {
        await db.query(
          `insert into ${q("efp_list_record_tags")}
             (id, chain_id, contract_address, slot, record, tag, created_at)
           values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (id) do nothing`,
          [t.id, t.chain_id, t.contract_address, t.slot, t.record, t.tag, t.created_at],
        );
      }
    },
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
