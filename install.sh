#!/bin/bash
# All execution is deferred until the final main call, including when read from stdin.
usage() {
  printf '%s\n' 'Usage: bash install.sh [install|update|uninstall]' 'Default: install. Use update to explicitly replace an installed package.'
}

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

require_tool() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found on PATH: $1"
}

version_at_least() {
  local version="${1#v}" major minor patch
  [[ "$version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)(\+[^[:space:]]+)?$ ]] || return 1
  major=$((10#${BASH_REMATCH[1]}))
  minor=$((10#${BASH_REMATCH[2]}))
  patch=$((10#${BASH_REMATCH[3]}))
  (( major > $2 || (major == $2 && minor > $3) || (major == $2 && minor == $3 && patch >= $4) ))
}

cleanup() {
  if [ -n "$installer_tmp" ]; then
    rm -rf -- "$installer_tmp"
  fi
}

main() {
  local action="${1:-install}" tool os arch node_version bun_version checkout commit
  [ "$#" -le 1 ] || fail 'Expected at most one action. Use --help for usage.'
  case "$action" in
    --help|help) usage; return 0 ;;
    install|update|uninstall) ;;
    *) fail "Unknown action: $action. Use --help for usage." ;;
  esac
  # An explicitly empty argument is not the default action.
  if [ "$#" -eq 1 ] && [ -z "$1" ]; then fail 'Empty action. Use --help for usage.'; fi
  require_tool tern
  if [ "$action" = uninstall ]; then
    printf '%s\n' 'Close bridge plugin sessions before removing the package.'
    tern plugin remove tern-bridge-pi || fail 'Tern could not remove the package; no manual cleanup was attempted.'
    printf '%s\n' 'Removed package only; plugin data, account/session history and the original Pi CLI are preserved.' 'Restart Tern and open a new local zsh pane.'
    return 0
  fi
  for tool in git node npm bun pi uname mktemp rm; do require_tool "$tool"; done
  node_version=$(node --version) || fail 'Cannot determine Node version.'
  version_at_least "$node_version" 22 19 0 || fail "Node >=22.19.0 is required (found $node_version)."
  bun_version=$(bun --version) || fail 'Cannot determine Bun version.'
  version_at_least "$bun_version" 1 3 14 || fail "Bun >=1.3.14 is required (found $bun_version)."
  os=$(uname -s) || fail 'Cannot determine operating system.'
  arch=$(uname -m) || fail 'Cannot determine architecture.'
  case "$os" in Darwin|Linux) ;; *) fail "Unsupported operating system: $os" ;; esac
  case "$arch" in arm64|aarch64|x86_64) ;; *) fail "Unsupported architecture: $arch" ;; esac
  if [ "$os/$arch" != Darwin/arm64 ]; then
    printf 'Warning: build target %s/%s is unverified; only Darwin arm64 is verified.\n' "$os" "$arch" >&2
  fi
  printf '%s\n' 'Close bridge plugin sessions before installing or updating.' 'Pi was found on PATH; this does not verify login or authentication readiness.'
  installer_tmp=''
  trap cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  installer_tmp=$(mktemp -d "${TMPDIR:-/tmp}/tern-bridge-pi.XXXXXXXX") || fail 'Cannot create temporary checkout.'
  [ -n "$installer_tmp" ] && [ -d "$installer_tmp" ] || fail 'Temporary directory was not created.'
  checkout="$installer_tmp/source"
  GIT_TERMINAL_PROMPT=0 git clone --depth 1 --branch main --single-branch https://github.com/justdoswift/tern-bridge-pi.git "$checkout" || fail 'Download failed; the installed package was not changed.'
  commit=$(git -C "$checkout" rev-parse HEAD) || fail 'Cannot determine downloaded commit.'
  printf 'Downloaded commit: %s\n' "$commit"
  (cd "$checkout" && npm ci --ignore-scripts --include=dev --include=optional && npm run package) || fail 'Build failed; the installed package was not changed.'
  [ -d "$checkout/artifacts/package/tern-bridge-pi" ] || fail 'Build did not produce the expected plugin package.'
  if [ "$action" = update ]; then
    tern plugin install "$checkout/artifacts/package/tern-bridge-pi" --force || fail 'Tern rejected the update. Linked installs remain protected; no unlink was attempted.'
  else
    tern plugin install "$checkout/artifacts/package/tern-bridge-pi" || fail 'Tern rejected installation. If already installed, run this installer with update. Linked installs remain protected.'
  fi
  printf '%s\n' 'Installed tern-bridge-pi. Restart Tern and open a new local zsh pane.'
}

main "$@"
