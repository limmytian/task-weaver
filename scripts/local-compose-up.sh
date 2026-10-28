#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"

umask 077
state_dir="$repo_root/.task-weaver/local-trial"
mkdir -p "$state_dir"
chmod 700 "$state_dir"
env_file="$state_dir/compose.env"

if [ -L "$env_file" ]; then
  printf '%s\n' 'Refusing to use a symlink for local trial credentials.' >&2
  exit 1
fi

if [ ! -f "$env_file" ]; then
  temporary_file="$env_file.tmp.$$"
  trap 'rm -f "$temporary_file"' EXIT HUP INT TERM
  database_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')
  auth_secret=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
  bootstrap_secret=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
  {
    printf 'TW_LOCAL_DATABASE_PASSWORD=%s\n' "$database_password"
    printf 'TW_LOCAL_AUTH_SECRET=%s\n' "$auth_secret"
    printf 'TW_LOCAL_BOOTSTRAP_SECRET=%s\n' "$bootstrap_secret"
  } > "$temporary_file"
  chmod 600 "$temporary_file"
  mv "$temporary_file" "$env_file"
  trap - EXIT HUP INT TERM
fi

chmod 600 "$env_file"
database_password=$(sed -n 's/^TW_LOCAL_DATABASE_PASSWORD=//p' "$env_file")
auth_secret=$(sed -n 's/^TW_LOCAL_AUTH_SECRET=//p' "$env_file")
bootstrap_secret=$(sed -n 's/^TW_LOCAL_BOOTSTRAP_SECRET=//p' "$env_file")
if [ "$(printf '%s' "$database_password" | wc -c | tr -d ' ')" -lt 40 ] \
  || [ "$(printf '%s' "$auth_secret" | wc -c | tr -d ' ')" -lt 64 ] \
  || [ "$(printf '%s' "$bootstrap_secret" | wc -c | tr -d ' ')" -lt 64 ]; then
  printf '%s\n' 'Local trial credentials are invalid; remove .task-weaver/local-trial/compose.env and retry.' >&2
  exit 1
fi

printf '%s\n' 'Starting the disposable Task Weaver trial on loopback ports.'
printf '%s\n' 'One-time first-administrator bootstrap secret (also saved locally with mode 0600):'
printf '%s\n' "$bootstrap_secret"
docker compose --env-file "$env_file" -f docker-compose.local.yml up -d --wait
