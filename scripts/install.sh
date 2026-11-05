#!/usr/bin/env bash
# Install the extracted portable package for the current user; never requires sudo.
set -euo pipefail

die() { printf 'Yansi: %s\n' "$*" >&2; exit 1; }
safe_path() {
  [[ "$1" == /* && ! "$1" =~ [[:cntrl:]] ]] || die "Use an absolute path without control characters: $1"
  realpath -ms -- "$1"
}
no_symlinks() {
  local candidate=$1
  while [[ "$candidate" != / ]]; do
    [[ ! -L "$candidate" ]] || die "Refusing a symbolic link in installation path: $candidate"
    candidate=$(dirname -- "$candidate")
  done
}
shell_quote() { printf "'%s'" "${1//\'/\'\\\'\'}"; }
# Exec is parsed once as a desktop-entry string, then as command arguments.
desktop_exec() {
  local value=$1
  value=${value//\\/\\\\}; value=${value//\"/\\\"}; value=${value//\`/\\\`}; value=${value//\$/\\\$}
  value=${value//%/%%}; value=${value//\\/\\\\}
  printf '"%s"' "$value"
}
desktop_value() { local value=$1; printf '%s' "${value//\\/\\\\}"; }
command_owned() {
  [[ -f "$command_path" && ! -L "$command_path" ]] &&
    [[ "$(head -n 3 -- "$command_path")" == "$(printf '#!/bin/sh\n# Yansi user installation\n# Install directory: %s' "$install_dir")" ]]
}
desktop_owned() {
  [[ -f "$desktop_path" && ! -L "$desktop_path" ]] &&
    grep -Fxq -- 'X-Yansi-Managed=true' "$desktop_path" &&
    grep -Fxq -- "X-Yansi-Install-Dir=$(desktop_value "$install_dir")" "$desktop_path"
}
icon_owned() {
  [[ ! -e "$icon_path" || -f "$icon_path" ]] &&
    [[ -f "$icon_owner" && ! -L "$icon_owner" ]] && [[ "$(cat -- "$icon_owner")" == "$install_dir" ]]
}

source_dir=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd)
install_dir=$(safe_path "${YANSI_INSTALL_DIR:-$HOME/.local/opt/yansi}")
bin_dir=$(safe_path "${YANSI_BIN_DIR:-$HOME/.local/bin}")
data_dir=$(safe_path "${XDG_DATA_HOME:-$HOME/.local/share}")
command_path=$bin_dir/yansi
desktop_path=$data_dir/applications/yansi.desktop
icon_path=$data_dir/icons/hicolor/512x512/apps/yansi.png
icon_owner=$data_dir/icons/hicolor/512x512/apps/.yansi-owner

for candidate in "$source_dir" "$install_dir" "$bin_dir" "$data_dir" "$command_path" "$desktop_path" "$icon_path" "$icon_owner"; do
  safe_path "$candidate" >/dev/null
done
for candidate in "$install_dir" "$command_path" "$desktop_path" "$icon_path" "$icon_owner"; do no_symlinks "$candidate"; done
[[ "$install_dir" != / && "$install_dir" != "$HOME" && "$install_dir" != "$bin_dir" && "$install_dir" != "$data_dir" ]] || die 'Unsafe installation directory.'
for managed_dir in "$bin_dir" "$data_dir"; do
  [[ "$managed_dir/" != "$install_dir/"* && "$install_dir/" != "$managed_dir/"* ]] || die 'The installation directory must be separate from command and desktop-data directories.'
done
[[ "$source_dir/" != "$install_dir/"* || "$source_dir" == "$install_dir" ]] || die 'The source package cannot be inside the installation directory.'
[[ "$install_dir/" != "$source_dir/"* || "$source_dir" == "$install_dir" ]] || die 'The installation directory cannot be inside the source package.'
for required in Yansi.sh yansi install.sh uninstall.sh icon.png README.md resources/app/package.json; do
  [[ -f "$source_dir/$required" ]] || die "Run install.sh from an extracted Yansi package; missing $required."
done

expected_manifest=$(printf 'yansi-user-install-v1\n%s\n%s\n%s\n%s' "$install_dir" "$command_path" "$desktop_path" "$icon_path")
if [[ -e "$install_dir" ]]; then
  [[ -d "$install_dir" && -f "$install_dir/.yansi-install" && ! -L "$install_dir/.yansi-install" ]] || die "The destination is not a managed Yansi installation: $install_dir"
  [[ "$(cat -- "$install_dir/.yansi-install")" == "$expected_manifest" ]] || die 'Existing installation uses different paths; uninstall it before changing destinations.'
fi
if [[ -e "$command_path" ]]; then command_owned || die "Refusing to replace an unrelated command: $command_path"; fi
if [[ -e "$desktop_path" ]]; then desktop_owned || die "Refusing to replace an unrelated desktop entry: $desktop_path"; fi
if [[ -e "$icon_path" || -e "$icon_owner" ]]; then icon_owned || die "Refusing to replace an unrelated icon: $icon_path"; fi

mkdir -p -- "$(dirname -- "$install_dir")" "$bin_dir" "$(dirname -- "$desktop_path")" "$(dirname -- "$icon_path")"
stage=''; backup=''; activated=0; success=0
cleanup() {
  local result=$?
  [[ -z "$stage" ]] || rm -rf -- "$stage"
  if [[ $success != 1 && -n "$backup" ]]; then
    [[ $activated != 1 ]] || rm -rf -- "$install_dir"
    mv -- "$backup" "$install_dir"
  elif [[ -n "$backup" ]]; then
    rm -rf -- "$backup"
  fi
  return "$result"
}
trap cleanup EXIT
if [[ "$source_dir" != "$install_dir" ]]; then
  stage=$(mktemp -d -- "$(dirname -- "$install_dir")/.yansi-stage.XXXXXXXX")
  cp -a -- "$source_dir/." "$stage/"
  printf '%s\n' "$expected_manifest" > "$stage/.yansi-install"
  if [[ -d "$install_dir" ]]; then
    backup=$(mktemp -d -- "$(dirname -- "$install_dir")/.yansi-backup.XXXXXXXX")
    rmdir -- "$backup"
    mv -- "$install_dir" "$backup"
  fi
  mv -- "$stage" "$install_dir"
  stage=''; activated=1
fi

temp_command=$(mktemp -- "$bin_dir/.yansi-command.XXXXXXXX")
{
  printf '#!/bin/sh\n# Yansi user installation\n# Install directory: %s\nexec ' "$install_dir"
  shell_quote "$install_dir/Yansi.sh"
  printf ' "$@"\n'
} > "$temp_command"
chmod 755 -- "$temp_command"
mv -f -- "$temp_command" "$command_path"

temp_desktop=$(mktemp -- "$(dirname -- "$desktop_path")/.yansi-desktop.XXXXXXXX")
{
  # env keeps percent field-code expansion in an argument, not GLib's executable lookup.
  printf '[Desktop Entry]\nType=Application\nName=Yansı\nGenericName=LAN screen sharing\nComment=Share your screen, system audio and files on your local network\nExec=/usr/bin/env '
  desktop_exec "$command_path"
  printf '\nIcon=yansi\nTerminal=false\nCategories=Network;RemoteAccess;\nStartupWMClass=Yansı\nX-Yansi-Managed=true\nX-Yansi-Install-Dir='
  desktop_value "$install_dir"
  printf '\n'
} > "$temp_desktop"
chmod 644 -- "$temp_desktop"
mv -f -- "$temp_desktop" "$desktop_path"
cp -- "$install_dir/icon.png" "$icon_path"
printf '%s\n' "$install_dir" > "$icon_owner"
chmod 644 -- "$icon_path" "$icon_owner"
success=1
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$(dirname -- "$desktop_path")" >/dev/null 2>&1 || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -f -t "$data_dir/icons/hicolor" >/dev/null 2>&1 || true
printf 'Installed Yansi in %s\nStart it from the applications menu or run: %s\nUninstall with: %s/uninstall.sh\n' "$install_dir" "$command_path" "$install_dir"
