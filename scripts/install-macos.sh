#!/usr/bin/env bash

set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install_dir="${TELEMACHUS_INSTALL_DIR:-${HOME}/Applications}"
source_app="${project_dir}/src-tauri/target/release/bundle/macos/Telemachus.app"
installed_app="${install_dir}/Telemachus.app"

cd "${project_dir}"
npm run build:mac

mkdir -p "${install_dir}"
if [ -e "${installed_app}" ]; then
  backup_suffix="$(date +%Y%m%d-%H%M%S)"
  mv "${installed_app}" "${install_dir}/Telemachus.previous-${backup_suffix}.app"
fi
/usr/bin/ditto "${source_app}" "${installed_app}"
/usr/bin/open "${installed_app}"

echo "Installed ${installed_app}"
echo "To keep it in the Dock, right-click its Dock icon and choose Options > Keep in Dock."
