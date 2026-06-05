#!/usr/bin/env bash
# Drives the full USDA bulk-import pipeline against hosted Supabase:
#   0. Downloads + unzips the four USDA JSON dumps (skips files
#      already present).
#   1. Loads Foundation, SR Legacy, Survey (FNDDS), Branded into
#      nutrition_foods_master.
#   2. Runs the keyword aggregator to fill global_conversions.
#   3. Redeploys the nutrition Edge Function (so the new master-table
#      path takes effect).
#
# Assumes you've already run `supabase db push`.
#
# Usage:
#   scripts/load-all-usda.sh [/path/to/usda-json-dir]
#
# If the dir isn't given, defaults to ./.cache/usda-fdc/ in the repo
# root. Either way, the script downloads the .zip dumps if the matching
# unzipped .json file isn't already present, so re-runs are cheap.
#
# Requires:
#   curl + unzip (standard system tools).
#   SUPABASE_ACCESS_TOKEN env var (for the function deploy at the end).
#   apps/web/.env.local.prod (or fallback) with SERVICE_ROLE_KEY for
#     the loader scripts.

set -euo pipefail

PROJECT_REF="xdyhhycfolcpqdawfkcj"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USDA_DIR="${1:-$REPO_ROOT/.cache/usda-fdc}"

mkdir -p "$USDA_DIR"
if [[ ! -d "$USDA_DIR" ]]; then
  echo "error: could not create $USDA_DIR" >&2
  exit 2
fi
echo "==> data dir: $USDA_DIR"

# ---------- Download phase ----------
#
# USDA forbids directory listings on /fdc-datasets/ (403), so we scrape
# the human-facing download page for the dated zip filenames and then
# fetch each from /fdc-datasets/<filename> directly (which works fine).
#
# If scraping doesn't return anything (rare — usually a network blip
# or USDA reshuffling the page), set the four URLs by hand:
#   FDC_FOUNDATION_URL=... FDC_SR_LEGACY_URL=... \
#   FDC_SURVEY_URL=... FDC_BRANDED_URL=... \
#   scripts/load-all-usda.sh

DATASETS_BASE="https://fdc.nal.usda.gov/fdc-datasets"
# Candidate pages that publish the current filenames. We try each
# until one returns HTML containing zip references.
SCRAPE_CANDIDATES=(
  "https://fdc.nal.usda.gov/download-datasets"
  "https://fdc.nal.usda.gov/download-datasets.html"
)

INDEX_HTML=""
for url in "${SCRAPE_CANDIDATES[@]}"; do
  # -s alone (no -S) so a 404/403 doesn't print a scary curl error.
  candidate="$(curl -fsL "$url" 2>/dev/null || true)"
  if [[ -n "$candidate" ]] && grep -q 'FoodData_Central_' <<<"$candidate"; then
    INDEX_HTML="$candidate"
    echo "==> scraped filenames from $url"
    break
  fi
done

find_zip_name() {
  # $1 = pattern fragment ('foundation_food_json' etc.). Returns the
  # filename of the most recent dated zip matching it, or empty.
  # Date format is YYYY-MM-DD on the recent releases but the
  # sr_legacy dump (last touched 2018-04) uses bare YYYY-MM — so the
  # trailing -DD is optional.
  local pattern="$1"
  [[ -z "$INDEX_HTML" ]] && return 0
  grep -oE "FoodData_Central_${pattern}_[0-9]{4}-[0-9]{2}(-[0-9]{2})?\.zip" <<<"$INDEX_HTML" \
    | sort -ru | head -n1
}

# Resolve a download URL per dataset: env-var override first, then
# scrape result, then fail with actionable instructions.
declare -A URLS
resolve_url() {
  local ds="$1" pattern="$2" override="$3"
  if [[ -n "$override" ]]; then
    URLS[$ds]="$override"
    return
  fi
  local name
  name="$(find_zip_name "$pattern")"
  if [[ -n "$name" ]]; then
    URLS[$ds]="$DATASETS_BASE/$name"
  fi
}
resolve_url foundation foundation_food_json "${FDC_FOUNDATION_URL:-}"
resolve_url sr_legacy  sr_legacy_food_json  "${FDC_SR_LEGACY_URL:-}"
resolve_url survey     survey_food_json     "${FDC_SURVEY_URL:-}"
resolve_url branded    branded_food_json    "${FDC_BRANDED_URL:-}"

missing=()
for ds in foundation sr_legacy survey branded; do
  [[ -z "${URLS[$ds]:-}" ]] && missing+=("$ds")
done
if (( ${#missing[@]} > 0 )); then
  cat >&2 <<EOF
error: couldn't find URLs for: ${missing[*]}

USDA's download page at $SCRAPE_CANDIDATES[0] didn't return any
FoodData_Central_*.zip references this run. Find the current dated
URLs at https://fdc.nal.usda.gov/download-datasets and re-run with:

  FDC_FOUNDATION_URL='https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_json_YYYY-MM-DD.zip' \\
  FDC_SR_LEGACY_URL='https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_json_YYYY-MM-DD.zip' \\
  FDC_SURVEY_URL='https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_survey_food_json_YYYY-MM-DD.zip' \\
  FDC_BRANDED_URL='https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_branded_food_json_YYYY-MM-DD.zip' \\
  scripts/load-all-usda.sh
EOF
  exit 3
fi

declare -A JSON_PATHS

ensure_dataset() {
  # $1 = dataset key, $2 = full download URL.
  # Populates JSON_PATHS[$ds] with the path to the unzipped json file.
  # USDA's zips are inconsistent — most extract to a json matching
  # the zip name, but `survey_food_json` extracts to `surveyDownload.json`.
  # We rename that one for consistency so the loader and re-runs both
  # see a deterministic filename.
  local ds="$1"
  local url="$2"
  local zip_name="${url##*/}"
  local expected_json="${zip_name%.zip}.json"
  local zip_path="$USDA_DIR/$zip_name"
  local json_path="$USDA_DIR/$expected_json"

  if [[ -f "$json_path" ]]; then
    echo "    $ds: $expected_json already present"
    JSON_PATHS[$ds]="$json_path"
    return 0
  fi
  if [[ ! -f "$zip_path" ]]; then
    echo "    $ds: downloading $url"
    curl -fL --retry 3 --retry-delay 5 -C - -o "$zip_path" "$url"
  else
    echo "    $ds: $zip_name already downloaded, unzipping"
  fi

  # Capture which files appeared during unzip so we can find the
  # one with a non-standard name (surveyDownload.json) and rename.
  local before_listing
  before_listing="$(find "$USDA_DIR" -maxdepth 1 -name '*.json' -type f | sort)"
  unzip -o -d "$USDA_DIR" "$zip_path" >/dev/null
  local after_listing
  after_listing="$(find "$USDA_DIR" -maxdepth 1 -name '*.json' -type f | sort)"
  local new_jsons
  mapfile -t new_jsons < <(comm -13 <(echo "$before_listing") <(echo "$after_listing"))

  if [[ -f "$json_path" ]]; then
    JSON_PATHS[$ds]="$json_path"
  elif (( ${#new_jsons[@]} == 1 )); then
    # Single new json with an unexpected name — rename to the expected
    # one so re-runs short-circuit on the `[[ -f $json_path ]]` check.
    echo "    $ds: renaming $(basename "${new_jsons[0]}") -> $expected_json"
    mv "${new_jsons[0]}" "$json_path"
    JSON_PATHS[$ds]="$json_path"
  else
    echo "error: $ds zip extracted ${#new_jsons[@]} json files; can't pick one" >&2
    printf '  %s\n' "${new_jsons[@]}" >&2
    return 1
  fi
}

echo "==> downloading dumps (skipping any already present)"
for ds in foundation sr_legacy survey branded; do
  ensure_dataset "$ds" "${URLS[$ds]}"
done
echo

# Cd to repo root so the relative env-file paths in the loader scripts
# resolve correctly regardless of where the user invoked from.
cd "$REPO_ROOT"

echo "==> using:"
echo "    foundation : ${JSON_PATHS[foundation]}"
echo "    sr_legacy  : ${JSON_PATHS[sr_legacy]}"
echo "    survey     : ${JSON_PATHS[survey]}"
echo "    branded    : ${JSON_PATHS[branded]}  (slow — ~20 min)"
echo

load() {
  local dataset="$1"
  local file="$2"
  local t0=$SECONDS
  echo "==> loading $dataset"
  # --node-modules-dir=auto so Deno 2 auto-installs the `npm:stream-json`
  # dependencies the loader needs to stream-parse the giant Branded
  # JSON. Cached under scripts/node_modules after first run.
  deno run --allow-env --allow-read --allow-net --allow-sys --node-modules-dir=auto \
    scripts/load-usda-foods.ts \
    --dataset "$dataset" \
    --file "$file"
  echo "    $dataset finished in $((SECONDS - t0))s"
  echo
}

# Foundation first (smallest — proves the pipeline works in seconds)
# then SR Legacy + Survey (medium) then Branded (long tail).
load foundation "${JSON_PATHS[foundation]}"
load sr_legacy  "${JSON_PATHS[sr_legacy]}"
load survey     "${JSON_PATHS[survey]}"
load branded    "${JSON_PATHS[branded]}"

echo "==> aggregating USDA portions into global_conversions"
deno run --allow-env --allow-read --allow-net \
  scripts/aggregate-usda-portions.ts
echo

if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  echo "==> SUPABASE_ACCESS_TOKEN not set; skipping function redeploy."
  echo "    Run manually when ready:"
  echo "      ./.bin/supabase functions deploy nutrition \\"
  echo "        --project-ref $PROJECT_REF --no-verify-jwt"
else
  echo "==> redeploying nutrition Edge Function"
  ./.bin/supabase functions deploy nutrition \
    --project-ref "$PROJECT_REF" \
    --no-verify-jwt
fi

echo
echo "✓ done. Reload the web app to trigger the local essentials pull"
echo "  (Foundation + SR Legacy, ~8k rows, cached for 30 days)."
