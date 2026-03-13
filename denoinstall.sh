#!/bin/sh
set -e
if ! command -v unzip >/dev/null && ! command -v 7z >/dev/null; then
	echo "Error: unzip or 7z is required to install Deno." 1>&2
	exit 1
fi
case $(uname -sm) in
"Darwin x86_64") target="x86_64-apple-darwin" ;;
"Darwin arm64") target="aarch64-apple-darwin" ;;
"Linux aarch64") target="aarch64-unknown-linux-gnu" ;;
*) target="x86_64-unknown-linux-gnu" ;;
esac
deno_version="${1:-$(curl -s https://dl.deno.land/release-latest.txt)}"
deno_install="${DENO_INSTALL:-$HOME/.deno}"
bin_dir="$deno_install/bin"
exe="$bin_dir/deno"
mkdir -p "$bin_dir"
curl --fail --location --progress-bar --output "$exe.zip" "https://dl.deno.land/release/${deno_version}/deno-${target}.zip"
if command -v unzip >/dev/null; then
	unzip -d "$bin_dir" -o "$exe.zip"
else
	7z x -o"$bin_dir" -y "$exe.zip"
fi
chmod +x "$exe"
rm "$exe.zip"
echo "Deno was installed successfully to $exe"
if $exe eval 'const [major, minor] = Deno.version.deno.split("."); if (major < 2 && minor < 42) Deno.exit(1)' 2>/dev/null; then
	$exe run -A --reload jsr:@deno/installer-shell-setup/bundled "$deno_install" -y
fi
echo "Done! Run '$exe --help' to get started"
