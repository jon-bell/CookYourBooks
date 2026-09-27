#!/usr/bin/env bash
# Run SQL against prod CookYourBooks Supabase via Management API.
# Usage: psql.sh "SELECT 1" | psql.sh -f file.sql | echo "SQL" | psql.sh
set -euo pipefail
TOKEN=$(cat ~/.supabase/access-token)
REF=xdyhhycfolcpqdawfkcj
TMP=$(mktemp); trap 'rm -f "$TMP" "$TMP.json"' EXIT
if [ "${1:-}" = "-f" ]; then cp "$2" "$TMP"; elif [ $# -ge 1 ]; then printf '%s' "$1" > "$TMP"; else cat > "$TMP"; fi
jq -nc --rawfile q "$TMP" '{query:$q}' > "$TMP.json"
curl -s -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data-binary "@$TMP.json"
