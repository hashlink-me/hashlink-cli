#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="${HOME}/.hashlink"
TARGET_FILE="${TARGET_DIR}/hashlink-cli.sh"
BIN_DIR="${HOME}/.local/bin"
CA_BIN_FILE="${BIN_DIR}/ca"
PRICE_BIN_FILE="${BIN_DIR}/price"

mkdir -p "${TARGET_DIR}"
mkdir -p "${BIN_DIR}"

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

price() {
  if [ -z "$1" ]; then
    echo "Usage: price <token_contract>"
    echo "Example: price 0x6982508145454Ce325dDbE47a25d4ec3d2311933"
    return 1
  fi

  token="$1"
  curl -s "https://data.hashlink.me/price/$token"
}
EOF

chmod +x "${TARGET_FILE}"

cat > "${CA_BIN_FILE}" <<'EOF'
#!/usr/bin/env sh

if [ -z "${1:-}" ]; then
  echo "Usage: ca <token_contract> [extra_query]"
  echo "Example: ca 0x6982508145454Ce325dDbE47a25d4ec3d2311933"
  echo "Example: ca 0x6982508145454Ce325dDbE47a25d4ec3d2311933 refresh=true"
  exit 1
fi

token="$1"
query="${2:-}"
url="https://data.hashlink.me/$token"

if [ -n "$query" ]; then
  url="$url?$query"
fi

curl -s "$url"
EOF

chmod +x "${CA_BIN_FILE}"

cat > "${PRICE_BIN_FILE}" <<'EOF'
#!/usr/bin/env sh

if [ -z "${1:-}" ]; then
  echo "Usage: price <token_contract>"
  echo "Example: price 0x6982508145454Ce325dDbE47a25d4ec3d2311933"
  exit 1
fi

token="$1"
curl -s "https://data.hashlink.me/price/$token"
EOF

chmod +x "${PRICE_BIN_FILE}"

SHELL_NAME="$(basename "${SHELL:-}")"
if [ "${SHELL_NAME}" = "zsh" ]; then
  RC_FILE="${HOME}/.zshrc"
elif [ "${SHELL_NAME}" = "bash" ]; then
  RC_FILE="${HOME}/.bashrc"
else
  RC_FILE="${HOME}/.zshrc"
fi

SOURCE_LINE='[ -f "$HOME/.hashlink/hashlink-cli.sh" ] && source "$HOME/.hashlink/hashlink-cli.sh"'
PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'

touch "${RC_FILE}"
if ! grep -Fq "$SOURCE_LINE" "${RC_FILE}"; then
  printf '\n%s\n' "${SOURCE_LINE}" >> "${RC_FILE}"
fi
if ! grep -Fq "$PATH_LINE" "${RC_FILE}"; then
  printf '%s\n' "${PATH_LINE}" >> "${RC_FILE}"
fi

echo "HashLink CLI shortcut installed."
echo "Executables installed at ${CA_BIN_FILE} and ${PRICE_BIN_FILE}"
echo "Reload your shell: source ${RC_FILE}"
echo "If your shell config is unavailable, run: export PATH=\"\$HOME/.local/bin:\$PATH\""
echo "Usage: ca <token_contract>"
echo "Usage: price <token_contract>"
