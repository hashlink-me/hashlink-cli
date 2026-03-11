#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="${HOME}/.hashlink"
TARGET_FILE="${TARGET_DIR}/hashlink-cli.sh"

mkdir -p "${TARGET_DIR}"

cat > "${TARGET_FILE}" <<'EOF'
#!/usr/bin/env sh

ca() {
  if [ -z "$1" ]; then
    echo "Usage: ca <token_contract> [extra_query]"
    echo "Example: ca 0x6982508145454Ce325dDbE47a25d4ec3d2311933"
    echo "Example: ca 0x6982508145454Ce325dDbE47a25d4ec3d2311933 refresh=true"
    return 1
  fi

  token="$1"
  query="$2"
  url="https://data.hashlink.me/$token"

  if [ -n "$query" ]; then
    url="$url?$query"
  fi

  curl -s "$url"
}
EOF

chmod +x "${TARGET_FILE}"

SHELL_NAME="$(basename "${SHELL:-}")"
if [ "${SHELL_NAME}" = "zsh" ]; then
  RC_FILE="${HOME}/.zshrc"
elif [ "${SHELL_NAME}" = "bash" ]; then
  RC_FILE="${HOME}/.bashrc"
else
  RC_FILE="${HOME}/.zshrc"
fi

SOURCE_LINE='[ -f "$HOME/.hashlink/hashlink-cli.sh" ] && source "$HOME/.hashlink/hashlink-cli.sh"'

touch "${RC_FILE}"
if ! grep -Fq "$SOURCE_LINE" "${RC_FILE}"; then
  printf '\n%s\n' "${SOURCE_LINE}" >> "${RC_FILE}"
fi

echo "HashLink CLI shortcut installed."
echo "Reload your shell: source ${RC_FILE}"
echo "Usage: ca <token_contract>"
