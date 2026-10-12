#!/usr/bin/env bash
# Build UpEnchant into a single .mcaddon (zipped behavior pack + resource pack).
set -euo pipefail

cd "$(dirname "$0")"

OUT="upenchant.mcaddon"
rm -f "$OUT"

# Validate JSON before packaging.
python3 - <<'PY'
import json, pathlib
for path in ("BP/manifest.json", "RP/manifest.json"):
    json.loads(pathlib.Path(path).read_text())
    print(f"ok: {path}")
PY

# .mcaddon is just a zip containing the pack folders at the top level.
python3 - <<'PY'
import zipfile, pathlib

out = pathlib.Path("upenchant.mcaddon")
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for pack in ("BP", "RP"):
        for file in sorted(pathlib.Path(pack).rglob("*")):
            if file.is_file():
                z.write(file, file.as_posix())
print(f"built {out}")
PY
