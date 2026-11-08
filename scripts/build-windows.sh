#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Bash supplies OSTYPE itself. Do not use a PATH-resolved uname here: other
# Windows tools (or an overridden uname command) can misidentify Git Bash.
case "${OSTYPE:-}" in
  msys*|mingw*) ;;
  *)
    printf 'Wrong Bash selected (OSTYPE=%s, MSYSTEM=%s).\n' \
      "${OSTYPE:-unset}" "${MSYSTEM:-unset}" >&2
    printf 'From your Windows project folder run: node scripts/build-windows.mjs\n' >&2
    printf 'Or explicitly select Git Bash:\n  "/c/Program Files/Git/bin/bash.exe" --noprofile --norc scripts/build-windows.sh\n' >&2
    exit 1
    ;;
esac
command -v rustup >/dev/null || { echo 'Install Rust using rustup from rustup.rs, then reopen Git Bash.' >&2; exit 1; }
command -v cargo >/dev/null || { echo 'Add ~/.cargo/bin to PATH, then reopen Git Bash.' >&2; exit 1; }
command -v node >/dev/null || { echo 'Install Node.js 22 LTS or newer first.' >&2; exit 1; }

# Choose the HOST toolchain too: --target alone does not change the compiler
# used for dependency build scripts and procedural macros.
export RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-msvc
export CARGO_BUILD_TARGET=x86_64-pc-windows-msvc
if ! rustup run "$RUSTUP_TOOLCHAIN" rustc --version; then
  printf '\nInstall the MSVC Rust toolchain in Git Bash:\n  rustup toolchain install %s --profile minimal\nThen rerun this script. Your global GNU default can stay unchanged.\n' "$RUSTUP_TOOLCHAIN" >&2
  exit 1
fi

# Check the linker and Windows SDK before npm installs or expensive Rust builds.
# rustc discovers the installed Visual Studio tools; Git Bash remains the shell.
mkdir -p .build/msvc-preflight
printf 'fn main() {}\n' > .build/msvc-preflight/probe.rs
if ! rustc --edition=2021 --crate-name prorun_build_probe \
  --target "$CARGO_BUILD_TARGET" .build/msvc-preflight/probe.rs \
  -o .build/msvc-preflight/probe.exe; then
  printf '\nMSVC link check failed. Install Visual Studio Build Tools with:\n  Desktop development with C++\n  MSVC x64/x86 tools and a Windows 10/11 SDK\nThen reopen Git Bash and rerun this script.\nhttps://v2.tauri.app/start/prerequisites/\n' >&2
  exit 1
fi

if [[ -f package-lock.json ]]; then npm ci; else npm install; fi
npm test
npm run build
cargo test --locked --manifest-path src-tauri/Cargo.toml --target "$CARGO_BUILD_TARGET"
npm run package -- --target "$CARGO_BUILD_TARGET"
mkdir -p artifacts
release_dir="src-tauri/target/$CARGO_BUILD_TARGET/release"
cp "$release_dir/prorun.exe" artifacts/ProRun.exe
cp "$release_dir"/bundle/nsis/*-setup.exe artifacts/
sha256sum artifacts/*.exe > artifacts/SHA256SUMS.txt
printf '\nWindows executables are ready in artifacts/\n'
