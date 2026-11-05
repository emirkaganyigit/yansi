#!/usr/bin/env bash
# Exercise the installer's filesystem boundaries without touching the user's home.
set -euo pipefail
project_dir=$(CDPATH= cd -P -- "$(dirname -- "$0")/.." && pwd)
test_dir=$(mktemp -d -- "${TMPDIR:-/tmp}/yansi installer.XXXXXXXX")
trap 'if [[ ${YANSI_INSTALL_TEST_KEEP:-0} == 1 ]]; then printf "Test files: %s\n" "$test_dir"; else rm -rf -- "$test_dir"; fi' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
expect_failure() { if "$@" > "$test_dir/rejected.log" 2>&1; then fail "Unexpected success: $*"; fi; }

package_dir=$test_dir/package
mkdir -p -- "$package_dir/resources/app"
cp -- "$project_dir/scripts/install.sh" "$project_dir/scripts/uninstall.sh" "$package_dir/"
cp -- "$project_dir/assets/icon.png" "$package_dir/icon.png"
printf '{}\n' > "$package_dir/resources/app/package.json"
printf 'Test package\n' > "$package_dir/README.md"
printf 'version one\n' > "$package_dir/version.txt"
cat > "$package_dir/Yansi.sh" <<'LAUNCHER'
#!/bin/sh
APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
unset ELECTRON_RUN_AS_NODE
exec "$APP_DIR/yansi" "$@"
LAUNCHER
cat > "$package_dir/yansi" <<'EXECUTABLE'
#!/bin/sh
printf '%s\n' "$@" > "$YANSI_TEST_OUTPUT"
EXECUTABLE
chmod 755 -- "$package_dir/"{Yansi.sh,yansi,install.sh,uninstall.sh}

# The command directory deliberately exercises both shell and desktop Exec escaping.
export YANSI_INSTALL_DIR="$test_dir/installed app's directory"
export YANSI_BIN_DIR="$test_dir/bin with spaces and \$ dollar \` tick % percent \\ slash \" quote"
export XDG_DATA_HOME="$test_dir/user data"
export YANSI_TEST_OUTPUT="$test_dir/launch-result"
command_path=$YANSI_BIN_DIR/yansi
desktop_path=$XDG_DATA_HOME/applications/yansi.desktop
icon_path=$XDG_DATA_HOME/icons/hicolor/512x512/apps/yansi.png
mkdir -p -- "$test_dir/user config" "$test_dir/downloads" "$XDG_DATA_HOME/applications"
printf 'keep settings\n' > "$test_dir/user config/settings.json"
printf 'keep download\n' > "$test_dir/downloads/file.txt"
printf 'unrelated\n' > "$XDG_DATA_HOME/applications/unrelated.desktop"

bash "$package_dir/install.sh" > "$test_dir/install.log"
[[ -x "$command_path" && -x "$YANSI_INSTALL_DIR/Yansi.sh" && -f "$desktop_path" && -f "$icon_path" ]] || fail 'Installation files are missing.'
"$command_path" 'argument with spaces' 'literal $ and ` and "'
[[ "$(cat -- "$YANSI_TEST_OUTPUT")" == $'argument with spaces\nliteral $ and ` and "' ]] || fail 'Launcher changed arguments.'
if command -v desktop-file-validate >/dev/null 2>&1; then desktop-file-validate "$desktop_path"; fi
if command -v gio >/dev/null 2>&1; then
  rm -- "$YANSI_TEST_OUTPUT"
  gio launch "$desktop_path" > "$test_dir/desktop-launch.log"
  for ((attempt=0; attempt<50; attempt++)); do
    [[ ! -f "$YANSI_TEST_OUTPUT" ]] || break
    sleep 0.02
  done
  [[ -f "$YANSI_TEST_OUTPUT" ]] || fail 'Desktop entry did not launch the installed command.'
fi

bash "$package_dir/install.sh" > "$test_dir/reinstall.log"
bash "$YANSI_INSTALL_DIR/install.sh" > "$test_dir/self-reinstall.log"
printf 'version two\n' > "$package_dir/version.txt"
bash "$package_dir/install.sh" > "$test_dir/upgrade.log"
[[ "$(cat -- "$YANSI_INSTALL_DIR/version.txt")" == 'version two' ]] || fail 'Upgrade did not replace application files.'

# A symlink must never turn an upgrade into an overwrite of an unrelated path.
mv -- "$command_path" "$test_dir/owned-command"
printf 'unrelated command\n' > "$test_dir/unrelated-command"
ln -s -- "$test_dir/unrelated-command" "$command_path"
expect_failure bash "$package_dir/install.sh"
[[ "$(cat -- "$test_dir/unrelated-command")" == 'unrelated command' ]] || fail 'Symlink target was modified.'
rm -- "$command_path"
mv -- "$test_dir/owned-command" "$command_path"

bash "$YANSI_INSTALL_DIR/uninstall.sh" > "$test_dir/uninstall.log"
[[ ! -e "$YANSI_INSTALL_DIR" && ! -e "$command_path" && ! -e "$desktop_path" && ! -e "$icon_path" ]] || fail 'Managed files survived uninstall.'
[[ -f "$test_dir/user config/settings.json" && -f "$test_dir/downloads/file.txt" && -f "$XDG_DATA_HOME/applications/unrelated.desktop" ]] || fail 'User data or unrelated files were removed.'

mkdir -p -- "$YANSI_INSTALL_DIR"
printf 'unrelated\n' > "$YANSI_INSTALL_DIR/keep.txt"
expect_failure bash "$package_dir/install.sh"
[[ -f "$YANSI_INSTALL_DIR/keep.txt" ]] || fail 'Conflicting directory was modified.'
rm -- "$YANSI_INSTALL_DIR/keep.txt"
rmdir -- "$YANSI_INSTALL_DIR"
mkdir -p -- "$(dirname -- "$command_path")"
printf 'unrelated\n' > "$command_path"
expect_failure bash "$package_dir/install.sh"
[[ "$(cat -- "$command_path")" == unrelated ]] || fail 'Unrelated command was overwritten.'
rm -- "$command_path"
expect_failure env YANSI_BIN_DIR="$YANSI_INSTALL_DIR/bin" bash "$package_dir/install.sh"
expect_failure env YANSI_INSTALL_DIR="$XDG_DATA_HOME/inside-data" bash "$package_dir/install.sh"
printf 'Installer tests passed: install, escaped launcher/desktop entry, reinstall, upgrade, symlink/conflict rejection, uninstall and data preservation.\n'
