#!/bin/bash

# Double-clickable, administrator-free bootstrap for macOS.
set -u

project_dir="$(cd -- "$(dirname -- "$0")" && pwd)" || exit 1
cd -- "$project_dir" || exit 1

node_version='24.20.0'
tools_dir="$project_dir/.tools"
download_dir=''

pause_if_interactive() {
  if [[ -t 0 ]]; then
    read -r -p 'Press Enter to close.'
  fi
}

finish() {
  setup_result=$?
  if [[ -n "$download_dir" && -d "$download_dir" ]]; then
    rm -rf -- "$download_dir"
  fi
  pause_if_interactive
  exit "$setup_result"
}
trap finish EXIT

node_is_compatible() {
  command -v node >/dev/null 2>&1 \
    && command -v npm >/dev/null 2>&1 \
    && [[ "$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null)" -ge 22 ]]
}

if ! node_is_compatible; then
  machine_arch="$(uname -m)"
  case "$machine_arch" in
    arm64)
      node_arch='arm64'
      expected_sha256='40e5607e5ecb3db9192723776da2d75d966260fc74a7a9e731c1bd67dda96bc8'
      ;;
    x86_64)
      node_arch='x64'
      expected_sha256='9e5b2644cf107befb6aefca676b96d3296bc10138096f022ed378d6233ed81f4'
      ;;
    *)
      echo "Setup stopped: unsupported Mac architecture: $machine_arch"
      echo 'Ask your IT team to install Node.js 24 LTS, then run this file again.'
      exit 1
      ;;
  esac

  archive_name="node-v${node_version}-darwin-${node_arch}.tar.gz"
  node_home="$tools_dir/node-v${node_version}-darwin-${node_arch}"
  node_url="https://nodejs.org/dist/v${node_version}/${archive_name}"

  if [[ ! -x "$node_home/bin/node" ]]; then
    command -v curl >/dev/null 2>&1 || {
      echo 'Setup stopped: macOS curl is unavailable. Ask your IT team for help.'
      exit 1
    }
    command -v shasum >/dev/null 2>&1 || {
      echo 'Setup stopped: macOS shasum is unavailable. Ask your IT team for help.'
      exit 1
    }

    mkdir -p -- "$tools_dir"
    download_dir="$(mktemp -d "$tools_dir/node-download.XXXXXX")" || exit 1
    echo "Node.js is missing or too old. Downloading the project-local Node.js ${node_version} runtime..."
    if ! curl --fail --location --show-error --output "$download_dir/$archive_name" "$node_url"; then
      echo 'Setup stopped: Node.js could not be downloaded. Check the network/proxy message above or ask IT.'
      exit 1
    fi

    actual_sha256="$(shasum -a 256 "$download_dir/$archive_name" | awk '{print $1}')"
    if [[ "$actual_sha256" != "$expected_sha256" ]]; then
      echo 'Setup stopped: the Node.js download checksum did not match. The file will not be used.'
      exit 1
    fi

    echo 'Download verified. Installing Node.js inside this project (no administrator password needed)...'
    tar -xzf "$download_dir/$archive_name" -C "$download_dir" || exit 1
    rm -rf -- "$node_home"
    mv -- "$download_dir/node-v${node_version}-darwin-${node_arch}" "$node_home" || exit 1
  fi

  export PATH="$node_home/bin:$PATH"
fi

echo "Using Node.js $(node --version) and npm $(npm --version)."
echo 'Installing the project packages and its private Chromium browser. This can take several minutes...'
npm run setup
