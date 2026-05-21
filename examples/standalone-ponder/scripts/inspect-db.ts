/**
 * Read-only verification script.
 *
 * Opens the standalone example's PGlite directory and prints row counts +
 * representative samples of every EFP table. Useful as a smoke-test
 * follow-up to confirm the plugin's handlers actually wrote the expected
 * rows during a backfill window.
 *
 *   pnpm exec tsx scripts/inspect-db.ts [--schema=ponder_efp_smoke]
 */

import { PGlite } from "@electric-sql/pglite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pgliteDir = path.resolve(__dirname, "../.ponder/pglite");

const schemaArg = process.argv.find((a) => a.startsWith("--schema="));
const schema = schemaArg ? schemaArg.split("=")[1] : "ponder_efp_smoke";

async function main() {
  const db = new PGlite(pgliteDir);

  const tableNames = [
    "efp_lists",
    "efp_list_records",
    "efp_list_record_tags",
    "efp_account_metadata",
    "efp_pending_list_metadata",
  ] as const;

  console.log(`Inspecting schema "${schema}" at ${pgliteDir}\n`);

  for (const t of tableNames) {
    try {
      const r = (await db.query(
        `select count(*)::int as c from ${schema}.${t}`,
      )) as { rows: Array<{ c: number }> };
      console.log(`${t.padEnd(30)} ${r.rows[0]?.c ?? 0} rows`);
    } catch (e) {
      console.log(`${t.padEnd(30)} ${(e as Error).message}`);
    }
  }

  console.log("\n--- sample efp_lists (oldest 5) ---");
  const lists = (await db.query(
    `select token_id, owner, "user", manager, list_storage_location_chain_id from ${schema}.efp_lists order by token_id::bigint limit 5`,
  )) as { rows: Array<Record<string, unknown>> };
  console.log(JSON.stringify(lists.rows, null, 2));

  console.log("\n--- sample efp_list_records (any 5) ---");
  const recs = (await db.query(
    `select chain_id, record_type, record_data from ${schema}.efp_list_records limit 5`,
  )) as { rows: Array<Record<string, unknown>> };
  console.log(JSON.stringify(recs.rows, null, 2));

  console.log("\n--- sample efp_account_metadata (any 5) ---");
  const am = (await db.query(
    `select address, key, value from ${schema}.efp_account_metadata limit 5`,
  )) as { rows: Array<Record<string, unknown>> };
  console.log(JSON.stringify(am.rows, null, 2));

  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
