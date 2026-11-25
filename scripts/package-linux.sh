#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
case "$(uname -s):$(uname -m)" in
    Linux:x86_64) arch=amd64 ;;
    Linux:aarch64) arch=arm64 ;;
    *) echo 'Run the packager on Linux x86-64 or ARM64.' >&2; exit 1 ;;
esac

output=${1:-dist}
archive=xbray-linux-${arch}.tar.gz
node_license="$(dirname -- "$(node -p 'process.execPath')")/../LICENSE"
if [[ ! -f "$node_license" ]]; then
    echo 'The official Node.js distribution, including its LICENSE file, is required.' >&2
    exit 1
fi

workdir=$(mktemp -d)
trap 'rm -rf -- "$workdir"' EXIT
stage="$workdir/archive"
mkdir -- "$stage"

npm exec --yes --package=esbuild@0.27.3 -- esbuild src/main.mjs \
    --bundle --platform=node --format=cjs --target=node22 --outfile="$workdir/xbray.cjs"
node -e 'const [main, output] = process.argv.slice(1); console.log(JSON.stringify({main, output, disableExperimentalSEAWarning: true, execArgvExtension: "none"}));' \
    "$workdir/xbray.cjs" "$stage/xbray" > "$workdir/sea.json"
node --build-sea "$workdir/sea.json"
chmod 0755 -- "$stage/xbray"

install -m 0755 -- scripts/install.sh scripts/xbrayctl "$stage"
install -m 0644 -- deploy/xbray.service deploy/node.env.example "$stage"
install -m 0644 -- "$node_license" "$stage/LICENSE.nodejs"

version=$(node -p 'require("./package.json").version')
[[ "$(env -i "$stage/xbray" --version)" == "xbray $version" ]]
sed 's/^XBOARD_TOKEN=$/XBOARD_TOKEN=package-test/' "$stage/node.env.example" > "$workdir/check.env"
env -i "$stage/xbray" --check-config "$workdir/check.env"

mkdir -p -- "$output"
tar --sort=name --mtime="@${SOURCE_DATE_EPOCH:-0}" --owner=0 --group=0 --numeric-owner \
    -C "$stage" -cf - LICENSE.nodejs install.sh node.env.example xbray xbray.service xbrayctl \
    | gzip -n > "$workdir/$archive"
(cd -- "$workdir" && sha256sum "$archive" > "$archive.sha256")
mv -- "$workdir/$archive" "$workdir/$archive.sha256" "$output/"
