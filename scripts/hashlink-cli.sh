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
