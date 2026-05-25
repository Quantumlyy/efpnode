#!/usr/bin/env bash
#
# Apply the EFP plugin to an ENSNode source tree.
#
# This script mirrors the 7-step integration documented in
# `packages/ensnode-plugin-efp/README.md` so the upstream PR is a no-op
# diff against what the Dockerfile produces.
#
# Usage:
#   integrate-into-ensnode.sh <ensnode_root> <plugin_src_dir>
#
# Where:
#   <ensnode_root>     path to a checked-out copy of github.com/namehash/ensnode
#   <plugin_src_dir>   path to packages/ensnode-plugin-efp/src/

set -euo pipefail

ENSNODE_ROOT="${1:?usage: $0 <ensnode_root> <plugin_src_dir>}"
PLUGIN_SRC="${2:?usage: $0 <ensnode_root> <plugin_src_dir>}"

# Resolve to absolute paths so subsequent commands don't depend on cwd.
ENSNODE_ROOT="$(cd "$ENSNODE_ROOT" && pwd)"
PLUGIN_SRC="$(cd "$PLUGIN_SRC" && pwd)"

echo "[efp-integrate] ensnode_root=$ENSNODE_ROOT"
echo "[efp-integrate] plugin_src=$PLUGIN_SRC"

cd "$ENSNODE_ROOT"

PLUGIN_DEST="apps/ensindexer/src/plugins/efp"
ABSTRACT_SCHEMA_DIR="packages/ensdb-sdk/src/ensindexer-abstract"

# ---------------------------------------------------------------------------
# 1) Copy the plugin source into the ENSIndexer plugins folder.
# ---------------------------------------------------------------------------
echo "[efp-integrate] copying plugin source -> $PLUGIN_DEST"
mkdir -p "$PLUGIN_DEST"
cp -r "$PLUGIN_SRC"/* "$PLUGIN_DEST"/

# ---------------------------------------------------------------------------
# 2) Hoist dropin/ entry points one level up so they sit next to the other
#    plugin's plugin.ts / event-handlers.ts, then strip the `@ts-expect-error`
#    comments (the imports now resolve inside ENSIndexer). Also rewrite the
#    `../` relative imports they used while nested in dropin/ to `./` now
#    that they live alongside the rest of the plugin sources.
# ---------------------------------------------------------------------------
if [ -d "$PLUGIN_DEST/dropin" ]; then
  mv "$PLUGIN_DEST/dropin/plugin.ts"          "$PLUGIN_DEST/plugin.ts"
  mv "$PLUGIN_DEST/dropin/event-handlers.ts"  "$PLUGIN_DEST/event-handlers.ts"
  rm -rf "$PLUGIN_DEST/dropin"
fi

# Drop every `@ts-expect-error: …` line — there's one per ENSNode-only import.
sed -i.bak '/@ts-expect-error/d' \
  "$PLUGIN_DEST/plugin.ts" \
  "$PLUGIN_DEST/event-handlers.ts"

# Rewrite the hoisted files' relative imports: ../X -> ./X (they were one
# level deeper before the move; the sibling files now sit next to them).
sed -i.bak 's|from "\.\./|from "./|g' \
  "$PLUGIN_DEST/plugin.ts" \
  "$PLUGIN_DEST/event-handlers.ts"

# Replace the runtime workaround the dropin files used when PluginName.EFP
# didn't exist (a structural cast) with a direct enum reference, now that
# step 5 below adds `EFP = "efp"` to the enum.
python3 - "$PLUGIN_DEST/plugin.ts" "$PLUGIN_DEST/event-handlers.ts" <<'PY'
import re, sys, pathlib
pattern = re.compile(
    r"const pluginName = \(PluginName as unknown as \{ EFP: [^}]+ \}\)\.EFP;",
)
for path in sys.argv[1:]:
    p = pathlib.Path(path)
    src = p.read_text()
    new = pattern.sub("const pluginName = PluginName.EFP;", src)
    if new != src:
        p.write_text(new)
        print(f"[efp-integrate] simplified PluginName.EFP usage in {p.name}")
PY

rm -f "$PLUGIN_DEST"/*.bak

# ---------------------------------------------------------------------------
# 3) Copy the schema definitions into the abstract package and replace the
#    in-plugin schema.ts with a re-export, so there is a single source of
#    truth that Ponder materialises.
# ---------------------------------------------------------------------------
cp "$PLUGIN_SRC/schema.ts" "$ABSTRACT_SCHEMA_DIR/efp.schema.ts"

cat > "$PLUGIN_DEST/schema.ts" <<'TS'
/**
 * Re-export the EFP tables from the abstract ENSIndexer schema. The actual
 * definitions live in `packages/ensdb-sdk/src/ensindexer-abstract/efp.schema.ts`
 * — the file Ponder reads via `ponder.schema.ts` — so the plugin's handlers
 * and Ponder reference the same table objects.
 */
export * from "@ensnode/ensdb-sdk/ensindexer-abstract";
TS

# ---------------------------------------------------------------------------
# 4) Re-export efp.schema from the abstract index so Ponder picks up the
#    tables.
# ---------------------------------------------------------------------------
python3 - "$ABSTRACT_SCHEMA_DIR/index.ts" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
src = p.read_text()
needle = 'export * from "./efp.schema";'
if needle not in src:
    if not src.endswith("\n"): src += "\n"
    src += needle + "\n"
    p.write_text(src)
    print(f"[efp-integrate] added re-export to {p}")
else:
    print(f"[efp-integrate] re-export already present in {p}")
PY

# ---------------------------------------------------------------------------
# 5) Add `EFP = "efp"` to the PluginName enum.
# ---------------------------------------------------------------------------
python3 - <<'PY'
import re, pathlib
p = pathlib.Path("packages/ensnode-sdk/src/ensindexer/config/types.ts")
src = p.read_text()
if "EFP = " in src:
    print(f"[efp-integrate] PluginName.EFP already present")
else:
    m = re.search(r"(export enum PluginName \{)(.*?)(\n\})", src, flags=re.S)
    if not m:
        raise SystemExit("could not find PluginName enum")
    new = m.group(1) + m.group(2).rstrip() + '\n  EFP = "efp",' + m.group(3)
    p.write_text(src.replace(m.group(0), new, 1))
    print(f"[efp-integrate] added EFP to PluginName")
PY

# ---------------------------------------------------------------------------
# 6) Register the plugin in ALL_PLUGINS.
# ---------------------------------------------------------------------------
python3 - <<'PY'
import pathlib
p = pathlib.Path("apps/ensindexer/src/plugins/index.ts")
src = p.read_text()
if "efpPlugin" in src:
    print(f"[efp-integrate] efpPlugin already in ALL_PLUGINS")
else:
    src = src.replace(
        'import unigraphPlugin from "./unigraph/plugin";',
        'import unigraphPlugin from "./unigraph/plugin";\n'
        'import efpPlugin from "./efp/plugin";',
    )
    src = src.replace(
        '  unigraphPlugin,\n] as const;',
        '  unigraphPlugin,\n  efpPlugin,\n] as const;',
    )
    p.write_text(src)
    print(f"[efp-integrate] added efpPlugin to ALL_PLUGINS")
PY

# ---------------------------------------------------------------------------
# 7) Wire `attach_EFPHandlers()` into register-handlers.ts.
# ---------------------------------------------------------------------------
python3 - <<'PY'
import pathlib
p = pathlib.Path("apps/ensindexer/ponder/src/register-handlers.ts")
src = p.read_text()
if "attach_EFPHandlers" in src:
    print(f"[efp-integrate] register-handlers.ts already wired")
else:
    src = src.replace(
        'import attach_UnigraphHandlers from "@/plugins/unigraph/event-handlers";',
        'import attach_UnigraphHandlers from "@/plugins/unigraph/event-handlers";\n'
        'import attach_EFPHandlers from "@/plugins/efp/event-handlers";',
    )
    if not src.endswith("\n"): src += "\n"
    src += "\nif (config.plugins.includes(PluginName.EFP)) {\n  attach_EFPHandlers();\n}\n"
    p.write_text(src)
    print(f"[efp-integrate] wired attach_EFPHandlers()")
PY

echo "[efp-integrate] done"
