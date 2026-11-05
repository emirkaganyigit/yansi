#!/usr/bin/env bash
# Remove this user's managed installation; configuration and downloads stay intact.
set -euo pipefail
die() { printf 'Yansi: %s\n' "$*" >&2; exit 1; }
safe_path() {
  [[ "$1" == /* && ! "$1" =~ [[:cntrl:]] ]] || die "Unsafe path: $1"
  [[ "$(realpath -ms -- "$1")" == "$1" ]] || die "Path is not normalized: $1"
  local candidate=$1
  while [[ "$candidate" != / ]]; do
    [[ ! -L "$candidate" ]] || die "Refusing a symbolic link: $candidate"
    candidate=$(dirname -- "$candidate")
  done
}
desktop_value() { local value=$1; printf '%s' "${value//\\/\\\\}"; }
source_dir=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd)
if [[ -f "$source_dir/.yansi-install" ]]; then
  install_dir=$source_dir
else
  install_dir=$(realpath -ms -- "${YANSI_INSTALL_DIR:-$HOME/.local/opt/yansi}")
fi
safe_path "$install_dir"
[[ "$install_dir" != / && "$install_dir" != "$HOME" ]] || die 'Unsafe installation directory.'
[[ -f "$install_dir/.yansi-install" && ! -L "$install_dir/.yansi-install" ]] || die "No managed Yansi installation at $install_dir."
mapfile -t manifest < "$install_dir/.yansi-install"
[[ ${#manifest[@]} == 5 && "${manifest[0]}" == yansi-user-install-v1 && "${manifest[1]}" == "$install_dir" ]] || die 'Invalid installation manifest.'
command_path=${manifest[2]}; desktop_path=${manifest[3]}; icon_path=${manifest[4]}
icon_owner=$(dirname -- "$icon_path")/.yansi-owner
for candidate in "$command_path" "$desktop_path" "$icon_path" "$icon_owner"; do safe_path "$candidate"; done
[[ $(basename -- "$command_path") == yansi && $(basename -- "$desktop_path") == yansi.desktop && $(basename -- "$icon_path") == yansi.png ]] || die 'Unexpected installation manifest paths.'
[[ -f "$install_dir/Yansi.sh" && -f "$install_dir/resources/app/package.json" ]] || die 'Installation is incomplete; refusing to remove this directory.'

if [[ -e "$command_path" ]]; then
  if [[ -f "$command_path" && "$(head -n 3 -- "$command_path")" == "$(printf '#!/bin/sh\n# Yansi user installation\n# Install directory: %s' "$install_dir")" ]]; then
    rm -- "$command_path"
  else printf 'Kept unrelated command: %s\n' "$command_path" >&2; fi
fi
if [[ -e "$desktop_path" ]]; then
  if [[ -f "$desktop_path" ]] && grep -Fxq -- 'X-Yansi-Managed=true' "$desktop_path" && grep -Fxq -- "X-Yansi-Install-Dir=$(desktop_value "$install_dir")" "$desktop_path"; then
    rm -- "$desktop_path"
  else printf 'Kept unrelated desktop entry: %s\n' "$desktop_path" >&2; fi
fi
if [[ -f "$icon_owner" && "$(cat -- "$icon_owner")" == "$install_dir" ]]; then
  [[ ! -f "$icon_path" ]] || rm -- "$icon_path"
  rm -- "$icon_owner"
elif [[ -e "$icon_path" || -e "$icon_owner" ]]; then printf 'Kept unrelated icon: %s\n' "$icon_path" >&2
fi
rm -rf -- "$install_dir"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$(dirname -- "$desktop_path")" >/dev/null 2>&1 || true
printf 'Yansi was uninstalled. Your settings and downloaded files were preserved.\n'
