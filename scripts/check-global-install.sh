#!/usr/bin/env bash
# Packs the package, installs the tarball into a throwaway global prefix and runs the installed bins.
# Needs the network (npm installs the runtime dependencies from the registry), so it is not part of `npm test`.
# Never publishes anything. Usage: scripts/check-global-install.sh
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

cd "$repo"
echo "== build"
npm run build --silent

echo "== pack"
mkdir -p "$tmp/pack"
npm pack --ignore-scripts --pack-destination "$tmp/pack" --silent >/dev/null
tarball="$(ls "$tmp"/pack/nightgem-*.tgz)"
echo "$tarball"

echo "== install into a temp prefix"
export HOME="$tmp/home"
mkdir -p "$HOME"
prefix="$tmp/prefix"
npm i -g --prefix "$prefix" --no-audit --no-fund "$tarball" >"$tmp/install.log" 2>&1 || { cat "$tmp/install.log" >&2; fail "npm install failed"; }
pkgdir="$prefix/lib/node_modules/nightgem"
[ -d "$pkgdir" ] || fail "package not installed at $pkgdir"

echo "== no tsx, no src in the installed package"
[ ! -e "$pkgdir/node_modules/tsx" ] || fail "tsx was installed with the package"
[ ! -e "$pkgdir/src" ] || fail "src/ was shipped"
[ -f "$pkgdir/dist/cli.js" ] || fail "dist/cli.js missing"

echo "== nightgem --help"
"$prefix/bin/nightgem" --help >"$tmp/help.log" 2>&1 || { cat "$tmp/help.log" >&2; fail "nightgem --help failed"; }
head -5 "$tmp/help.log"

echo "== entries load"
"$prefix/bin/nightgem" --check
node "$pkgdir/bin/nightgem-orchestrator.mjs" --check

echo "== orchestrator with an unknown slug exits 1"
set +e
node "$pkgdir/bin/nightgem-orchestrator.mjs" --slug does-not-exist >"$tmp/orch.log" 2>&1
orc=$?
set -e
cat "$tmp/orch.log"
[ "$orc" -eq 1 ] || fail "orchestrator exit code $orc, expected 1"

echo "== nightgem doctor (FAILs about the missing profile are expected)"
set +e
"$prefix/bin/nightgem" doctor >"$tmp/doctor.log" 2>&1
set -e
cut -c1-160 "$tmp/doctor.log"

if grep -rqs "ERR_MODULE_NOT_FOUND" "$tmp"/help.log "$tmp"/doctor.log "$tmp"/orch.log; then
  fail "ERR_MODULE_NOT_FOUND in the output"
fi
grep -q "^ok    orchestrator entry" "$tmp/doctor.log" || fail "doctor did not report the orchestrator entry as ok"

echo "OK: global install from the tarball works"
