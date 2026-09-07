#!/bin/bash
cd -- "$(dirname -- "$0")" || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo 'Node.js is missing or unavailable. Install Node.js 24 LTS using the macOS installer at https://nodejs.org/en/download.'
  echo 'Then restart your agent app and reopen this setup file. Homebrew is not required.'
  read -r -p 'Press Enter to close.'
  exit 1
fi
npm run setup
setup_result=$?
read -r -p 'Press Enter to close.'
exit "$setup_result"
