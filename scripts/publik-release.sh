#!/usr/bin/env bash
# publik-release.sh — cuts one Ghost release for every OS Ghost ships, in ONE command (docs/updates.md ›
# Cut a release):
#
#   scripts/publik-release.sh <version> [--notes-file <file>] [--no-publish]     e.g. scripts/publik-release.sh 0.1.11
#
# Run it on the maintainer's Mac: the Developer ID certificate, the notarytool profile "publik" and the publik
# update key (keychain service publik-update-key) are in its keychain.
#   1. checks    on main, clean tree, in step with origin; <version> is newer than the latest release; the tag
#                v<version> is free (a DRAFT v<version> of the same commit is resumed). The version bump: if
#                package.json is not <version> yet, the script bumps every file a bump touches (package.json,
#                package-lock.json, README.md, SETUP.md; CHANGELOG.md gets the section "## <version>" from
#                --notes-file unless it has one), commits and pushes to main. Then it checks all of them.
#   2. CI        publik-build.yml on this commit (no tag input: it only makes workflow artifacts): the unsigned
#                Ghost.app for arm64 and x64 and the Windows installer, all built with the publik app token,
#                tested, and launch-checked on the runners (sign-in gate, self-test). A green run is reused.
#   3. draft     a DRAFT release v<version> that targets this commit (the tag is made when it is published)
#   4. macOS     per architecture (arm64, x64): signs Ghost.app on this Mac with "Developer ID Application: Mann
#                Bellani (R5R3ZS54LV)" (inner code first, hardened runtime, build/entitlements.mac.plist on
#                executables and helper apps), notarizes it (notarytool, profile "publik"), staples it, makes the
#                update zip from the stapled app, then the dmg (signed, notarized, stapled)
#   5. Windows   the NSIS installer of the same CI run (not code-signed, as every Ghost release). CI installed it
#                and wrote the fingerprint of the publik app token in the installed app; the script checks the
#                installer bytes against that record and the token against the last release
#   6. feed      SHA256SUMS.txt, latest.yml and latest-mac.yml with absolute GitHub URLs, signed with the update
#                key from the keychain (scripts/publik-update-feed.cjs sign; the key is never printed)
#   7. verify    downloads every file back from the draft: feed signatures (the app's public key), sha256/sha512,
#                sizes, versions (Info.plist, exe = feed), codesign, Developer ID, designated requirement,
#                entitlements, stapler, spctl, the publik app token (= the last release's), CI green on the commit
#   8. publish   only when every check passed: the release becomes public and "latest"; the public URLs must
#                answer, and no file may change after publishing
# It stops before publishing at the first failed check (the release stays a DRAFT), can run again to resume
# (state: $PUBLIK_RELEASE_WORK, default ${TMPDIR}/publik-release-ghost-<version>), starts no app and prints no
# secret. GitHub API calls are retried, and a wait makes at most one call per 90 seconds (the API limit is shared).
#
# Environment (all optional):
#   PUBLIK_RELEASE_WORK       the work folder
#   PUBLIK_RELEASE_TRAILER    a trailer line for the version-bump commit (e.g. a Co-Authored-By line)
#   PUBLIK_RELEASE_NEW_TOKEN  1: the publik app token may differ from the last release's (after a rotation)
set -euo pipefail
set +x
umask 022

APP=Ghost
SLUG=ghost
REPO=Blueturboguy07/ghost-location
BRANCH=main
BUNDLE_ID=org.ghostlocation.desktop
TEAM=R5R3ZS54LV
IDENTITY="Developer ID Application: Mann Bellani ($TEAM)"
NOTARY_PROFILE=publik
KEY_SERVICE=publik-update-key
KEY_ID=F5E0515C77912BD0
DR_EXPECTED="identifier \"$BUNDLE_ID\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = $TEAM"
ARCHES="arm64 x64"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECK="$ROOT/scripts/publik-release-check.cjs"
ENT="$ROOT/build/entitlements.mac.plist"

step() { printf '\n== %s\n' "$*"; }
say() { printf '      %s\n' "$*"; }
ok() { printf 'ok    %s\n' "$*"; }
die() { printf '\npublik-release: STOP: %s\n' "$*" >&2; exit 1; }
FAILS=0
bad() { printf 'FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }

# gh with retries: a failed call (the shared API limit, the network) is tried again after 90 seconds.
ghr() {
  local i out
  for i in 1 2 3 4 5; do
    if out="$(gh "$@")"; then printf '%s\n' "$out"; return 0; fi
    [ "$i" = 5 ] || { say "gh $1 $2 failed (try $i of 5): waiting 90 s"; sleep 90; }
  done
  return 1
}

VERSION="${1:-}"
shift || true
NOTES_FILE=""
PUBLISH=1
while [ $# -gt 0 ]; do
  case "$1" in
    --notes-file) NOTES_FILE="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; shift 2 ;;
    --no-publish) PUBLISH=0; shift ;;
    *) die "unknown option $1" ;;
  esac
done
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "usage: scripts/publik-release.sh X.Y.Z [--notes-file F] [--no-publish]"
TAG="v$VERSION"
EXE="$APP-$VERSION-win-x64.exe"
zip_name() { echo "$APP-$VERSION-mac-$1.zip"; }
dmg_name() { echo "$APP-$VERSION-mac-$1.dmg"; }
INSTALLERS="$(zip_name arm64) $(zip_name x64) $(dmg_name arm64) $(dmg_name x64) $EXE"
FEED_FILES="latest.yml latest.yml.sig latest-mac.yml latest-mac.yml.sig"
ALL_ASSETS="$INSTALLERS SHA256SUMS.txt $FEED_FILES"
BASE="https://github.com/$REPO/releases/download/$TAG/"

WORK="${PUBLIK_RELEASE_WORK:-${TMPDIR:-/tmp}/publik-release-$SLUG-$VERSION}"
mkdir -p "$WORK/tmp"
WORK="$(cd "$WORK" && pwd)"
export TMPDIR="$WORK/tmp" # gh, node and npx keep their temporary files here
mkdir "$WORK/lock" 2>/dev/null || die "another run holds $WORK/lock (remove it if no run is active)"
trap 'rmdir "$WORK/lock" 2>/dev/null || true' EXIT
free_mb() { df -m "$WORK" | awk 'NR==2 { print $4 }'; }
need_mb() { # <MB> <what>: stops (resumable) when the disk lacks the room
  local f; f="$(free_mb)"
  [ "$f" -ge "$1" ] || die "$2 needs about $1 MB of free disk; $f MB are free. Free some space, then run the same command again (it resumes)."
}
plist() { /usr/libexec/PlistBuddy -c "Print :$2" "$1/Contents/Info.plist" 2>/dev/null; }
sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }

# ------------------------------------------------------------------------------------------- 0. tools
step "0. tools, signing identity, keys"
[ "$(uname)" = Darwin ] || die "run this on the Mac that holds the Developer ID certificate"
for t in gh git node npx xcrun codesign spctl hdiutil ditto security shasum lipo plutil curl df; do
  command -v "$t" > /dev/null || die "missing tool: $t"
done
gh auth status > /dev/null 2>&1 || die "gh is not logged in"
security find-identity -v -p codesigning | grep -qF "\"$IDENTITY\"" || die "the keychain has no \"$IDENTITY\""
security find-generic-password -s "$KEY_SERVICE" -a mann-private > /dev/null 2>&1 || die "the keychain has no $KEY_SERVICE/mann-private"
security find-generic-password -s "$KEY_SERVICE" -a mann-password > /dev/null 2>&1 || die "the keychain has no $KEY_SERVICE/mann-password"
xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" > /dev/null 2>&1 || die "notarytool has no working keychain profile \"$NOTARY_PROFILE\""
[ -f "$ENT" ] || die "$ENT is missing"
ok "tools, \"$IDENTITY\", the update key, notary profile \"$NOTARY_PROFILE\"; work folder $WORK ($(free_mb) MB free)"

# ------------------------------------------------------------------------------------------- 1. checks and the bump
step "1. checks ($TAG)"
cd "$ROOT"
git fetch --quiet origin "$BRANCH" --tags
[ "$(git rev-parse --abbrev-ref HEAD)" = "$BRANCH" ] || die "check out $BRANCH first"
[ -z "$(git status --porcelain)" ] || die "the working tree is not clean"
LAST_TAG="$(ghr release view -R "$REPO" --json tagName --jq .tagName)" || die "cannot read the latest release"
LAST="${LAST_TAG#v}"
newer() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)" = "$1" ]; }
newer "$VERSION" "$LAST" || die "$VERSION is not newer than the latest release $LAST_TAG"
ok "the latest release is $LAST_TAG; $VERSION is newer"
if git ls-remote --exit-code --tags origin "refs/tags/$TAG" > /dev/null 2>&1; then
  die "the tag $TAG exists on origin (a published release or a stray tag): pick the next version"
fi
REL="$(gh release view "$TAG" -R "$REPO" --json isDraft,targetCommitish 2>/dev/null || true)"
if [ -n "$REL" ] && [ "$(node -p 'JSON.parse(process.argv[1]).isDraft' "$REL")" != true ]; then
  die "a published release $TAG exists"
fi
ok "the tag $TAG is free${REL:+ (a draft $TAG exists: it is resumed)}"

bump_check() { # every file a bump touches names $VERSION (and the version-specific lines no longer name $LAST)
  node - "$VERSION" "$LAST" <<'JS'
const fs = require('fs');
const [v, last] = process.argv.slice(2);
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const l = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const readme = fs.readFileSync('README.md', 'utf8');
const setup = fs.readFileSync('SETUP.md', 'utf8');
const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');
const want = {
  'package.json version': p.version === v,
  'package-lock.json version': l.version === v,
  'package-lock.json packages[""].version': l.packages[''].version === v,
  'README.md "Current version: **X**"': readme.includes(`Current version: **${v}**`),
  'README.md download link': readme.includes(`Get [Ghost ${v} for Mac or Windows](https://github.com/Blueturboguy07/ghost-location/releases/tag/v${v})`),
  'SETUP.md download line': setup.includes(`Download **Ghost ${v}** from [GitHub Releases](https://github.com/Blueturboguy07/ghost-location/releases/tag/v${v})`),
  'SETUP.md file names': ['mac-arm64.dmg', 'mac-x64.dmg', 'win-x64.exe'].every((s) => setup.includes(`\`Ghost-${v}-${s}\``)),
  'SETUP.md no old file names': !setup.includes(`Ghost-${last}-`),
  'CHANGELOG.md section': new RegExp(`^## ${v.replace(/\./g, '\\.')}$`, 'm').test(changelog),
};
const bad = Object.entries(want).filter(([, x]) => !x).map(([k]) => k);
if (bad.length) { console.log(`not bumped: ${bad.join('; ')}`); process.exit(1); }
JS
}
if [ "$(node -p 'require("./package.json").version')" != "$VERSION" ]; then
  [ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$BRANCH")" ] || die "HEAD is not origin/$BRANCH: push or pull first"
  say "bumping $LAST -> $VERSION in package.json, package-lock.json, README.md, SETUP.md, CHANGELOG.md"
  if ! grep -qx "## $VERSION" CHANGELOG.md; then
    [ -n "$NOTES_FILE" ] && [ -s "$NOTES_FILE" ] || die "CHANGELOG.md has no section \"## $VERSION\": write it, or pass --notes-file with its lines"
  fi
  node - "$VERSION" "$LAST" "$NOTES_FILE" <<'JS'
const fs = require('fs');
const [v, last, notes] = process.argv.slice(2);
const json = (f, edit) => { const o = JSON.parse(fs.readFileSync(f, 'utf8')); edit(o); fs.writeFileSync(f, `${JSON.stringify(o, null, 2)}\n`); };
json('package.json', (p) => { p.version = v; });
json('package-lock.json', (l) => { l.version = v; l.packages[''].version = v; });
// Only the lines that name the current download: "Current version", the download links and the file table.
const swap = (f) => {
  const lines = fs.readFileSync(f, 'utf8').split('\n').map((line) => {
    if (!/Current version: \*\*|for Mac or Windows\]\(|Download \*\*Ghost |^\|.*`Ghost-\d/.test(line)) return line;
    for (const [a, b] of [[`**${last}**`, `**${v}**`], [`Ghost ${last}`, `Ghost ${v}`], [`/tag/v${last})`, `/tag/v${v})`], [`Ghost-${last}-`, `Ghost-${v}-`]]) line = line.split(a).join(b);
    return line;
  });
  fs.writeFileSync(f, lines.join('\n'));
};
swap('README.md');
swap('SETUP.md');
let c = fs.readFileSync('CHANGELOG.md', 'utf8');
if (!new RegExp(`^## ${v.replace(/\./g, '\\.')}$`, 'm').test(c)) {
  const body = fs.readFileSync(notes, 'utf8').trim();
  c = c.replace(/^# Changelog\n\n/, `# Changelog\n\n## ${v}\n\n${body}\n\n`);
  fs.writeFileSync('CHANGELOG.md', c);
}
JS
  bump_check || die "the bump is incomplete (above)"
  changed="$(git diff --name-only | LC_ALL=C sort | tr '\n' ' ')"
  [ "$changed" = "CHANGELOG.md README.md SETUP.md package-lock.json package.json " ] || die "the bump changed [$changed]"
  MSG="Ghost $VERSION: release"$'\n\n'"Version $VERSION in package.json, package-lock.json, README.md, SETUP.md and CHANGELOG.md (scripts/publik-release.sh)."
  [ -n "${PUBLIK_RELEASE_TRAILER:-}" ] && MSG="$MSG"$'\n\n'"$PUBLIK_RELEASE_TRAILER"
  git add package.json package-lock.json README.md SETUP.md CHANGELOG.md
  git commit --quiet -m "$MSG"
  git push --quiet origin "$BRANCH"
  git fetch --quiet origin "$BRANCH"
  ok "committed and pushed the bump: $(git rev-parse --short HEAD)"
fi
bump_check || die "the bump is incomplete (above): fix it in a commit on $BRANCH, then run again"
SHA="$(git rev-parse HEAD)"
[ "$SHA" = "$(git rev-parse "origin/$BRANCH")" ] || die "HEAD $SHA is not origin/$BRANCH: push first"
ok "$VERSION in package.json, package-lock.json, README.md, SETUP.md, CHANGELOG.md; commit $SHA = origin/$BRANCH"
if [ -n "$REL" ]; then
  target="$(node -p 'JSON.parse(process.argv[1]).targetCommitish' "$REL")"
  [ "$target" = "$SHA" ] || die "the draft $TAG targets $target, not $SHA: delete that draft (gh release delete $TAG -R $REPO) or check out its commit"
fi
STATE="$WORK/${SHA:0:12}" # one work folder per commit: nothing of another commit is reused
REC="$STATE/records"
mkdir -p "$STATE" "$REC"
for d in "$WORK"/*/; do
  case "$d" in "$STATE/"|"$WORK/tmp/") ;; *) [ -d "$d/records" ] && { rm -r "$d"; say "deleted the work folder of another commit: $d"; } ;; esac
done

# ------------------------------------------------------------------------------------------- 2. CI build
step "2. CI build (publik-build.yml) for $SHA"
run_status() { ghr run view "$1" -R "$REPO" --json headSha,status,conclusion --jq '"\(.headSha) \(.status) \(.conclusion)"'; }
wait_run() { # <run id> <what>: one API call per 90 s
  local s
  say "waiting for $2: https://github.com/$REPO/actions/runs/$1"
  while :; do
    s="$(run_status "$1" || echo 'unknown unknown unknown')"
    case "$s" in *" completed "*) break ;; esac
    sleep 90
  done
  [ "${s%% *}" = "$SHA" ] || die "$2 ran on ${s%% *}, not $SHA"
  [ "${s##* }" = success ] || die "$2 ended with ${s##* }: https://github.com/$REPO/actions/runs/$1 (run the script again to start a new build)"
  ok "$2: success (run $1)"
}
RUN="$(cat "$STATE/ci-run" 2>/dev/null || true)"
if [ -n "$RUN" ]; then
  case "$(run_status "$RUN" || true)" in
    "$SHA completed success" | "$SHA in_progress "* | "$SHA queued "* | "$SHA waiting "* | "$SHA pending "*) ;;
    *) say "the earlier run $RUN is not usable: a new one"; RUN="" ;;
  esac
fi
if [ -z "$RUN" ]; then
  RUN="$(ghr run list -R "$REPO" -w publik-build.yml -c "$SHA" -L 10 --json databaseId,status,conclusion \
    --jq '[.[] | select(.status != "completed" or .conclusion == "success")] | sort_by(.databaseId) | last | .databaseId // ""')"
fi
if [ -z "$RUN" ]; then
  since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  ghr workflow run publik-build.yml -R "$REPO" --ref "$BRANCH" > /dev/null || die "cannot start publik-build.yml"
  for i in 1 2 3 4 5 6; do
    if [ "$i" = 1 ]; then sleep 30; else sleep 90; fi
    RUN="$(ghr run list -R "$REPO" -w publik-build.yml -c "$SHA" -e workflow_dispatch -L 5 --json databaseId,createdAt \
      --jq "[.[] | select(.createdAt >= \"$since\")] | sort_by(.databaseId) | last | .databaseId // \"\"" || true)"
    [ -n "$RUN" ] && break
  done
  [ -n "$RUN" ] || die "the publik-build.yml run for $SHA did not show up"
  say "started publik-build.yml: run $RUN"
fi
echo "$RUN" > "$STATE/ci-run"
wait_run "$RUN" "publik build"
STEPS="$(ghr run view "$RUN" -R "$REPO" --json jobs --jq '[.jobs[] | .name as $j | .steps[] | select(.conclusion != "skipped") | select(.name | test("publik app token|sign-in gate|Test adapters")) | "\($j): \(.name)=\(.conclusion)"] | join("\n")')"
printf '%s\n' "$STEPS" | sed 's/^/      /'
[ "$(grep -c '=success$' <<< "$STEPS")" -ge 10 ] && ! grep -qv '=success$' <<< "$STEPS" \
  || die "the CI run $RUN did not pass every token, test and sign-in-gate step (above)"
ok "CI run $RUN: tests, the publik app token in every build, the sign-in gate in every packaged app"

# ------------------------------------------------------------------------------------------- 3. draft, the last release's token
step "3. draft release $TAG"
RELEASE_ID="$(ghr api "repos/$REPO/releases" --paginate --jq ".[] | select(.tag_name == \"$TAG\") | .id" || true)"
if [ -z "$RELEASE_ID" ]; then
  NOTES="$STATE/notes.md"
  {
    echo "Ghost $VERSION."
    echo
    awk -v h="## $VERSION" '$0 == h { on = 1; next } /^## / { on = 0 } on' CHANGELOG.md | sed '/./,$!d'
    echo
    echo "Downloads: **mac-arm64** for Apple Silicon, **mac-x64** for Intel Mac, **win-x64.exe** for 64-bit Windows. The Mac downloads are signed with a Developer ID and notarized by Apple. The Windows installer is not code-signed."
    echo
    echo "Ghost 0.1.10 and later install this version themselves (they ask before they restart). Ghost 0.1.9 and older: download it one time by hand."
    echo
    echo "\`SHA256SUMS.txt\` holds the file hashes. \`latest.yml\`, \`latest-mac.yml\` and their \`.sig\` files are the update feed ([docs/updates.md](https://github.com/$REPO/blob/$TAG/docs/updates.md))."
  } > "$NOTES"
  gh release create "$TAG" -R "$REPO" --draft --target "$SHA" --title "Ghost $VERSION" --notes-file "$NOTES" > /dev/null || true
  RELEASE_ID="$(ghr api "repos/$REPO/releases" --paginate --jq ".[] | select(.tag_name == \"$TAG\") | .id" || true)"
  [ -n "$RELEASE_ID" ] || die "the draft $TAG was not created"
  ok "draft $TAG created (release $RELEASE_ID, target $SHA)"
else
  ok "resuming the draft $TAG (release $RELEASE_ID)"
fi
assets_json() { ghr api "repos/$REPO/releases/$RELEASE_ID/assets" --paginate --jq '.[] | "\(.name) \(.digest // "none")"'; }
ASSET_CACHE="" # a file with the output of assets_json: digest_of reads it instead of the API
digest_of() {
  if [ -n "$ASSET_CACHE" ]; then awk -v n="$1" '$1 == n { print $2 }' "$ASSET_CACHE"
  else assets_json | awk -v n="$1" '$1 == n { print $2 }'; fi
}
upload() { # <file>: puts the file on the draft unless the same bytes are there; checks the digest after
  local f="$1" name want remote
  name="$(basename "$f")"
  want="sha256:$(sha256 "$f")"
  remote="$(digest_of "$name")"
  if [ "$remote" = "$want" ]; then ok "$name is on the draft already"; return; fi
  [ -z "$remote" ] || say "replacing $name on the draft ($remote)"
  ghr release upload "$TAG" "$f" -R "$REPO" --clobber > /dev/null || die "the upload of $name failed"
  remote="$(digest_of "$name")"
  [ "$remote" = "$want" ] || die "after the upload, $name on the draft has $remote; the local file has $want"
  ok "uploaded $name ($want)"
}
recorded_on_draft() { # <name>: the draft holds the bytes this script recorded for that name
  [ -f "$REC/$1.json" ] && [ "$(digest_of "$1")" = "sha256:$(node -p 'require(process.argv[1]).sha256' "$REC/$1.json")" ]
}
if [ "${PUBLIK_RELEASE_NEW_TOKEN:-}" = 1 ]; then
  TOKEN_WANT=""
  say "PUBLIK_RELEASE_NEW_TOKEN=1: the publik app token may differ from $LAST_TAG's"
else
  TOKEN_WANT="$(node "$CHECK" remote-token "https://github.com/$REPO/releases/download/$LAST_TAG/$APP-$LAST-mac-arm64.zip")" \
    || die "cannot read the publik app token fingerprint of $LAST_TAG"
  case "$TOKEN_WANT" in "pat_ "*) ;; *) die "$LAST_TAG has no publik app token ($TOKEN_WANT)" ;; esac
  ok "publik app token of $LAST_TAG: $TOKEN_WANT (a fingerprint, not the token)"
fi
asar_check() { # <Ghost.app> <label>
  local out
  if [ -n "$TOKEN_WANT" ]; then out="$(node "$CHECK" asar "$1/Contents/Resources/app.asar" --version "$VERSION" --token "$TOKEN_WANT")" || { printf '%s\n' "$out" | sed 's/^/      /'; return 1; }
  else out="$(node "$CHECK" asar "$1/Contents/Resources/app.asar" --version "$VERSION")" || { printf '%s\n' "$out" | sed 's/^/      /'; return 1; }; fi
  printf '%s\n' "$out" | sed "s/^PASS /ok    $2: /"
}

# ------------------------------------------------------------------------------------------- helpers: macOS
app_checks() { # <Ghost.app> <arch> <label>: returns 1 on a failure (each failure is printed)
  local app="$1" arch="$2" label="$3" fails=0 want_arch v dv dr ent gk
  want_arch="$arch"; [ "$arch" = x64 ] && want_arch=x86_64
  v="$(plist "$app" CFBundleShortVersionString)"
  [ "$v" = "$VERSION" ] && ok "$label: Info.plist CFBundleShortVersionString $v" || { bad "$label: Info.plist version $v, not $VERSION"; fails=1; }
  [ "$(plist "$app" CFBundleIdentifier)" = "$BUNDLE_ID" ] && ok "$label: bundle ID $BUNDLE_ID" || { bad "$label: bundle ID $(plist "$app" CFBundleIdentifier)"; fails=1; }
  [ "$(lipo -archs "$app/Contents/MacOS/$APP")" = "$want_arch" ] && ok "$label: lipo $want_arch" || { bad "$label: lipo $(lipo -archs "$app/Contents/MacOS/$APP")"; fails=1; }
  codesign --verify --deep --strict "$app" 2>/dev/null && ok "$label: codesign --verify --deep --strict" || { bad "$label: codesign --verify --deep --strict"; fails=1; }
  dv="$(codesign -dvv "$app" 2>&1)"
  grep -qxF "Authority=$IDENTITY" <<< "$dv" && grep -qxF "TeamIdentifier=$TEAM" <<< "$dv" && grep -q 'flags=0x10000(runtime)' <<< "$dv" \
    && ok "$label: signed by $IDENTITY, hardened runtime" || { bad "$label: $(grep -E '^(Authority|TeamIdentifier|CodeDirectory)' <<< "$dv" | tr '\n' ' ')"; fails=1; }
  dr="$(codesign -d -r- "$app" 2>&1 | sed -n 's/^designated => //p')"
  [ "$dr" = "$DR_EXPECTED" ] && ok "$label: designated requirement as every Developer ID release (the TCC grants keep)" || { bad "$label: designated requirement $dr"; fails=1; }
  ent="$(codesign -d --entitlements - --xml "$app" 2>/dev/null || true)"
  grep -q 'com.apple.security.cs.allow-jit' <<< "$ent" && grep -q 'com.apple.security.cs.disable-library-validation' <<< "$ent" \
    && ok "$label: entitlements of build/entitlements.mac.plist" || { bad "$label: entitlements"; fails=1; }
  xcrun stapler validate "$app" > /dev/null 2>&1 && ok "$label: stapler validate" || { bad "$label: no stapled ticket"; fails=1; }
  gk="$(spctl -a -vvv -t exec "$app" 2>&1 || true)"
  grep -q ': accepted' <<< "$gk" && grep -qx 'source=Notarized Developer ID' <<< "$gk" && ok "$label: spctl accepted, source=Notarized Developer ID" || { bad "$label: spctl: $(tr '\n' ' ' <<< "$gk")"; fails=1; }
  asar_check "$app" "$label" || { bad "$label: app.asar (above)"; fails=1; }
  return $fails
}
dmg_checks() { # <dmg> <arch> <label>
  local dmg="$1" arch="$2" label="$3" fails=0 info gk mnt="$STATE/mnt"
  codesign --verify --strict "$dmg" 2>/dev/null && ok "$label: codesign --verify" || { bad "$label: codesign --verify"; fails=1; }
  info="$(codesign -dvv "$dmg" 2>&1)"
  grep -qxF "Authority=$IDENTITY" <<< "$info" && ok "$label: signed by $IDENTITY" || { bad "$label: not signed by $IDENTITY"; fails=1; }
  xcrun stapler validate "$dmg" > /dev/null 2>&1 && ok "$label: stapler validate" || { bad "$label: no stapled ticket"; fails=1; }
  gk="$(spctl -a -t open --context context:primary-signature -vv "$dmg" 2>&1 || true)"
  grep -q ': accepted' <<< "$gk" && grep -qx 'source=Notarized Developer ID' <<< "$gk" && ok "$label: spctl accepted, source=Notarized Developer ID" || { bad "$label: spctl: $(tr '\n' ' ' <<< "$gk")"; fails=1; }
  mkdir -p "$mnt"
  if hdiutil attach "$dmg" -nobrowse -noautoopen -readonly -mountpoint "$mnt" -quiet; then
    [ -L "$mnt/Applications" ] && ok "$label: the Applications link" || { bad "$label: no Applications link"; fails=1; }
    app_checks "$mnt/$APP.app" "$arch" "$label › $APP.app" || fails=1
    hdiutil detach "$mnt" -quiet || hdiutil detach "$mnt" -force -quiet
  else
    bad "$label: does not mount"; fails=1
  fi
  return $fails
}
notarize() { # <file> <label>: resumes a submission that is still waiting
  local file="$1" label="$2" id status
  id="$(cat "$STATE/notary-$label" 2>/dev/null || true)"
  if [ -z "$id" ]; then
    xcrun notarytool submit "$file" --keychain-profile "$NOTARY_PROFILE" --no-wait --output-format plist > "$STATE/notary-$label-submit.plist" \
      || die "notarytool submit of the $label failed"
    id="$(plutil -extract id raw "$STATE/notary-$label-submit.plist")"
    echo "$id" > "$STATE/notary-$label"
  fi
  say "notarization of the $label: submission $id, waiting for Apple"
  xcrun notarytool wait "$id" --keychain-profile "$NOTARY_PROFILE" --timeout 2h > "$STATE/notary-$label-wait.txt" 2>&1 || true
  xcrun notarytool info "$id" --keychain-profile "$NOTARY_PROFILE" --output-format plist > "$STATE/notary-$label-info.plist" || die "notarytool info $id failed"
  status="$(plutil -extract status raw "$STATE/notary-$label-info.plist")"
  if [ "$status" != Accepted ]; then
    xcrun notarytool log "$id" --keychain-profile "$NOTARY_PROFILE" "$STATE/notary-$label-log.json" > /dev/null 2>&1 || true
    rm -f "$STATE/notary-$label"
    die "notarization of the $label: $status (Apple's log: $STATE/notary-$label-log.json)"
  fi
  ok "notarization of the $label: Accepted (submission $id)"
}
sign_app() { # <Ghost.app>: as every signed Ghost release: inner code first, deepest first; executables and helper
  # apps get the entitlements, libraries and frameworks none; the main executable of a bundle is signed with it
  local app="$1" kind f dir fw n_exec=0 n_lib=0 b
  sig() { local out; out="$(codesign --force --sign "$IDENTITY" --options runtime --timestamp "$@" 2>&1)" || die "codesign failed on ${*: -1}: $out"; }
  while IFS=$'\t' read -r kind f; do
    case "$f" in *.app/Contents/MacOS/*) continue ;; esac
    dir="$(dirname "$f")"
    case "$dir" in *.framework/Versions/*) fw="$(basename "${dir%/Versions/*}")"; [ "$(basename "$f")" = "${fw%.framework}" ] && continue ;; esac
    if [ "$kind" = exec ]; then sig --entitlements "$ENT" "$f"; n_exec=$((n_exec + 1)); else sig "$f"; n_lib=$((n_lib + 1)); fi
  done < <(node "$CHECK" macho "$app/Contents")
  while IFS= read -r b; do
    case "$b" in *.app) sig --entitlements "$ENT" "$b" ;; *) sig "$b" ;; esac
  done < <(find "$app/Contents" -type d \( -name '*.framework' -o -name '*.app' \) | awk -F/ '{ print NF "\t" $0 }' | sort -rn | cut -f2-)
  sig --entitlements "$ENT" "$app"
  say "signed $n_exec loose executables (with entitlements), $n_lib libraries, the nested bundles and $APP.app"
}

# ------------------------------------------------------------------------------------------- 4. macOS
CHANGED=0
for ARCH in $ARCHES; do
  ZIP="$(zip_name "$ARCH")"
  DMG="$(dmg_name "$ARCH")"
  D="$STATE/mac-$ARCH"
  A="$D/x/$APP.app"
  if recorded_on_draft "$ZIP" && recorded_on_draft "$DMG"; then ok "$ZIP and $DMG are on the draft"; continue; fi
  step "4. macOS $ARCH"
  if ! recorded_on_draft "$ZIP"; then
    CHANGED=1
    if [ ! -d "$A" ]; then
      rm -f "$STATE/mac-$ARCH-signed" "$STATE/mac-$ARCH-stapled" "$STATE/notary-app-$ARCH"
      need_mb 1300 "the $ARCH app (download, unpack, sign, notarize, zip, dmg)"
      [ ! -d "$D" ] || rm -r "$D"
      mkdir -p "$D"
      ghr run download "$RUN" -R "$REPO" -n "ghost-mac-$ARCH-unsigned-app" -D "$D/artifact" > /dev/null || die "cannot download the $ARCH app of run $RUN"
      ditto -x -k "$D/artifact/Ghost-mac-$ARCH-unsigned-app.zip" "$D/x"
      rm -r "$D/artifact"
      [ -d "$A" ] || die "no $APP.app in the $ARCH artifact of run $RUN"
      ok "$ARCH: the unsigned app of run $RUN ($(du -sm "$A" | cut -f1) MB)"
    fi
    [ "$(plist "$A" CFBundleShortVersionString)" = "$VERSION" ] || die "$ARCH: the CI app is $(plist "$A" CFBundleShortVersionString), not $VERSION"
    if [ ! -f "$STATE/mac-$ARCH-signed" ]; then
      asar_check "$A" "$ARCH (unsigned, from CI)" || die "$ARCH: the app from CI failed a check (above)"
      sign_app "$A"
      codesign --verify --deep --strict "$A" || die "$ARCH: codesign --verify after signing"
      touch "$STATE/mac-$ARCH-signed"
    fi
    if [ ! -f "$STATE/mac-$ARCH-stapled" ]; then
      if [ ! -f "$STATE/notary-app-$ARCH" ]; then
        need_mb 300 "the notarization zip"
        ditto -c -k --keepParent "$A" "$D/notarize.zip"
        notarize "$D/notarize.zip" "app-$ARCH"
        rm -f "$D/notarize.zip"
      else
        notarize "$A" "app-$ARCH"
      fi
      xcrun stapler staple "$A" > /dev/null || die "$ARCH: stapling the app failed"
      touch "$STATE/mac-$ARCH-stapled"
    fi
    app_checks "$A" "$ARCH" "$ARCH $APP.app (signed here)" || die "$ARCH: the signed app failed a check (above)"
    need_mb 300 "the update zip"
    ditto -c -k --sequesterRsrc --keepParent "$A" "$D/$ZIP"
    node "$CHECK" record "$D/$ZIP" "$REC" | sed 's/^/      /'
    upload "$D/$ZIP"
    rm -f "$D/$ZIP"
  elif [ ! -d "$A" ] && [ ! -f "$D/$DMG" ]; then
    # The zip is on the draft, the dmg is not: the stapled app comes back from the draft's zip.
    need_mb 900 "the stapled $ARCH app from the draft"
    [ ! -d "$D" ] || rm -r "$D"
    mkdir -p "$D"
    ghr release download "$TAG" -R "$REPO" -p "$ZIP" -D "$D" > /dev/null || die "cannot download $ZIP from the draft"
    ditto -x -k "$D/$ZIP" "$D/x"
    rm -f "$D/$ZIP"
    app_checks "$A" "$ARCH" "$ARCH $APP.app (from the draft's zip)" || die "$ARCH: the app in $ZIP failed a check (above)"
  fi
  if ! recorded_on_draft "$DMG"; then
    CHANGED=1
    if [ ! -f "$D/$DMG" ]; then
      rm -f "$STATE/notary-dmg-$ARCH" "$STATE/dmg-$ARCH-done"
      need_mb 400 "the dmg"
      mkdir -p "$D/stage"
      mv "$A" "$D/stage/$APP.app"
      ln -sfn /Applications "$D/stage/Applications"
      hdiutil create -quiet -volname "$APP $VERSION" -srcfolder "$D/stage" -fs HFS+ -format UDZO -ov "$D/$DMG" || die "$ARCH: hdiutil create failed"
      mv "$D/stage/$APP.app" "$A"
      rm -r "$D/stage"
      codesign --force --sign "$IDENTITY" --timestamp "$D/$DMG" || die "$ARCH: signing the dmg failed"
    fi
    [ ! -d "$D/x" ] || rm -r "$D/x"
    if [ ! -f "$STATE/dmg-$ARCH-done" ]; then
      notarize "$D/$DMG" "dmg-$ARCH"
      xcrun stapler staple "$D/$DMG" > /dev/null || die "$ARCH: stapling the dmg failed"
      dmg_checks "$D/$DMG" "$ARCH" "$DMG" || die "$ARCH: the dmg failed a check (above)"
      touch "$STATE/dmg-$ARCH-done"
    fi
    node "$CHECK" record "$D/$DMG" "$REC" | sed 's/^/      /'
    upload "$D/$DMG"
  fi
  [ ! -d "$D" ] || rm -r "$D"
  ok "$ARCH: $ZIP and $DMG are on the draft; the local copies are deleted"
done

# ------------------------------------------------------------------------------------------- 5. Windows
if recorded_on_draft "$EXE"; then
  ok "$EXE is on the draft"
else
  step "5. Windows: $EXE"
  CHANGED=1
  need_mb 400 "the Windows installer"
  W="$STATE/win"
  [ ! -d "$W" ] || rm -r "$W"
  ghr run download "$RUN" -R "$REPO" -n ghost-win-x64 -D "$W" > /dev/null || die "cannot download the Windows installer of run $RUN"
  [ -f "$W/$EXE" ] || die "$EXE is not in the ghost-win-x64 artifact of run $RUN ($(ls "$W" | tr '\n' ' '))"
  [ -f "$W/Ghost-win-x64-token.json" ] || die "the ghost-win-x64 artifact of run $RUN has no Ghost-win-x64-token.json"
  node "$CHECK" exe "$W/$EXE" --version "$VERSION" | sed 's/^PASS /ok    /' || die "$EXE: version (above)"
  node - "$W/Ghost-win-x64-token.json" "$EXE" "$(sha256 "$W/$EXE")" "$TOKEN_WANT" <<'JS' || die "$EXE: the publik app token record of CI (above)"
const [file, name, sha, want] = process.argv.slice(2);
const r = JSON.parse(require('fs').readFileSync(file, 'utf8'));
const okName = r.installer === name, okSha = r.sha256 === sha, okToken = r.token.startsWith('pat_ ') && (!want || r.token === want);
console.log(`${okName && okSha ? 'ok   ' : 'FAIL '} CI installed exactly this installer (${r.installer}, sha256 ${r.sha256})`);
console.log(`${okToken ? 'ok   ' : 'FAIL '} the app it installed carries the publik app token ${r.token}${want ? ` (the last release: ${want})` : ''}`);
process.exit(okName && okSha && okToken ? 0 : 1);
JS
  node "$CHECK" record "$W/$EXE" "$REC" | sed 's/^/      /'
  upload "$W/$EXE"
  rm -r "$W"
fi

# ------------------------------------------------------------------------------------------- 6. SHA256SUMS.txt and the signed feed
for f in $INSTALLERS; do [ -f "$REC/$f.json" ] || die "no record of $f (delete it from the draft and run again: gh release delete-asset $TAG $f -R $REPO)"; done
OUT="$STATE/out"
mkdir -p "$OUT"
node "$CHECK" sums-file "$REC" "$OUT/SHA256SUMS.txt" $INSTALLERS
recorded_on_draft SHA256SUMS.txt && [ "$(node -p 'require(process.argv[1]).sha256' "$REC/SHA256SUMS.txt.json")" = "$(sha256 "$OUT/SHA256SUMS.txt")" ] || {
  step "6. SHA256SUMS.txt"
  sed 's/^/      /' "$OUT/SHA256SUMS.txt"
  node "$CHECK" record "$OUT/SHA256SUMS.txt" "$REC" > /dev/null
  upload "$OUT/SHA256SUMS.txt"
  CHANGED=1
}
FEED_OK=1
for f in $FEED_FILES; do recorded_on_draft "$f" || FEED_OK=0; done
if [ "$CHANGED" = 1 ] || [ "$FEED_OK" = 0 ] || [ ! -f "$STATE/feed-done" ]; then
  step "6. the update feed (signed with the update key from the keychain; the key is not printed)"
  rm -f "$STATE/feed-done"
  [ ! -d "$OUT/feed" ] || rm -r "$OUT/feed"
  node "$CHECK" write-feed --app "$SLUG" --version "$VERSION" --base "$BASE" --records "$REC" --out "$OUT/feed" | sed 's/^/      /'
  (
    PUBLIK_UPDATE_KEY="$(security find-generic-password -s "$KEY_SERVICE" -a mann-private -w)"
    PUBLIK_UPDATE_KEY_PASSWORD="$(security find-generic-password -s "$KEY_SERVICE" -a mann-password -w)"
    export PUBLIK_UPDATE_KEY PUBLIK_UPDATE_KEY_PASSWORD
    node "$ROOT/scripts/publik-update-feed.cjs" sign "$OUT/feed/latest.yml" "$OUT/feed/latest-mac.yml"
  ) | sed 's/^/      /' || die "signing the feed failed"
  for f in $FEED_FILES; do
    node "$CHECK" record "$OUT/feed/$f" "$REC" > /dev/null
    upload "$OUT/feed/$f"
  done
  touch "$STATE/feed-done"
fi

# ------------------------------------------------------------------------------------------- 7. verify the draft
step "7. verify: every file downloaded back from the draft"
V="$STATE/verify"
[ ! -d "$V" ] || rm -r "$V"
mkdir -p "$V/feed" "$V/files"
REL="$(ghr release view "$TAG" -R "$REPO" --json isDraft,targetCommitish,assets)"
[ "$(node -p 'JSON.parse(process.argv[1]).isDraft' "$REL")" = true ] && ok "$TAG is a draft" || bad "$TAG is not a draft"
[ "$(node -p 'JSON.parse(process.argv[1]).targetCommitish' "$REL")" = "$SHA" ] && ok "$TAG targets $SHA" || bad "$TAG does not target $SHA"
GOT="$(node -p 'JSON.parse(process.argv[1]).assets.map((a) => a.name).sort().join(" ")' "$REL")"
WANT="$(printf '%s\n' $ALL_ASSETS | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//')"
[ "$(tr ' ' '\n' <<< "$GOT" | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//')" = "$WANT" ] && ok "the draft holds exactly: $WANT" || bad "the draft holds [$GOT], want [$WANT]"
assets_json > "$V/assets.txt" || die "cannot list the files of the draft"
ASSET_CACHE="$V/assets.txt"
for f in $ALL_ASSETS; do recorded_on_draft "$f" && ok "$f on the draft: $(digest_of "$f") = the file made here" || bad "$f on the draft is not the file this script made"; done
ASSET_CACHE=""
ghr release download "$TAG" -R "$REPO" -D "$V/feed" -p 'latest*' -p SHA256SUMS.txt > /dev/null || die "cannot download the feed from the draft"
node "$CHECK" feed "$V/feed" "$V/files" --version "$VERSION" --app "$SLUG" --base "$BASE" | grep -v '^skip' | sed 's/^PASS /ok    /; s/^FAIL /FAIL  /' > "$V/feed.txt" || true
cat "$V/feed.txt"
FAILS=$((FAILS + $(grep -c '^FAIL' "$V/feed.txt" || true)))
[ "$(grep -c "^ok .*\.sig verifies with the app's public key (key $KEY_ID" "$V/feed.txt" || true)" = 2 ] && ok "both feeds are signed with the publik update key $KEY_ID" || bad "the feeds are not both signed with key $KEY_ID"
for f in $INSTALLERS; do
  need_mb 800 "the check of $f"
  ghr release download "$TAG" -R "$REPO" -p "$f" -D "$V/files" > /dev/null || die "cannot download $f from the draft"
  [ "$(sha256 "$V/files/$f")" = "$(node -p 'require(process.argv[1]).sha256' "$REC/$f.json")" ] && ok "$f: the downloaded bytes = the file made here" || bad "$f: the downloaded bytes differ from the file made here"
  for out in "$(node "$CHECK" feed "$V/feed" "$V/files" --version "$VERSION" --app "$SLUG" --base "$BASE" | grep -F " $f: ")" \
             "$(node "$CHECK" sums "$V/feed/SHA256SUMS.txt" "$V/files" | grep -F " $f: ")"; do
    [ -n "$out" ] || { bad "$f: not in the feed or in SHA256SUMS.txt"; continue; }
    case "$out" in PASS*) ok "${out#PASS }" ;; *) bad "${out#FAIL }" ;; esac
  done
  case "$f" in
    *.exe) node "$CHECK" exe "$V/files/$f" --version "$VERSION" | sed 's/^PASS /ok    /; s/^FAIL /FAIL  /' > "$V/exe.txt" || true
           cat "$V/exe.txt"; FAILS=$((FAILS + $(grep -c '^FAIL' "$V/exe.txt" || true))) ;;
    *.zip) ARCH="${f##*-mac-}"; ARCH="${ARCH%.zip}"
           xattr -w com.apple.quarantine "0083;$(printf '%x' "$(date +%s)");Safari;$(uuidgen)" "$V/files/$f"
           mkdir -p "$V/x"
           ditto -x -k "$V/files/$f" "$V/x"
           rm -f "$V/files/$f"
           app_checks "$V/x/$APP.app" "$ARCH" "$f › $APP.app" || true
           rm -r "$V/x" ;;
    *.dmg) ARCH="${f##*-mac-}"; ARCH="${ARCH%.dmg}"
           dmg_checks "$V/files/$f" "$ARCH" "$f" || true ;;
  esac
  rm -f "$V/files/$f"
done
step "7. CI (build.yml) on $SHA"
CI=""
for i in $(seq 1 60); do
  CI="$(ghr run list -R "$REPO" -w build.yml -c "$SHA" -L 5 --json databaseId,status,conclusion \
    --jq 'sort_by(.databaseId) | last | select(. != null) | "\(.status) \(.conclusion) \(.databaseId)"' || true)"
  if [ -z "$CI" ] && [ "$i" = 1 ]; then
    say "no build.yml run on $SHA: starting one"
    ghr workflow run build.yml -R "$REPO" --ref "$BRANCH" > /dev/null || true
  fi
  case "$CI" in completed*) break ;; esac
  sleep 90
done
case "$CI" in "completed success "*) ok "build.yml run ${CI##* } on $SHA: success" ;; *) bad "build.yml on $SHA: ${CI:-no run}" ;; esac
if [ "$FAILS" -gt 0 ]; then
  die "$FAILS check(s) failed: $TAG stays a DRAFT. Fix the cause and run the same command again (to make a file again, delete it from the draft: gh release delete-asset $TAG <file> -R $REPO)."
fi
ok "every check passed"

# ------------------------------------------------------------------------------------------- 8. publish
if [ "$PUBLISH" = 0 ]; then
  step "stopped before publishing (--no-publish): the draft $TAG is complete and verified"
  exit 0
fi
step "8. publish $TAG"
BEFORE="$(assets_json | sort)"
ghr release edit "$TAG" -R "$REPO" --draft=false --latest > /dev/null || die "publishing $TAG failed: it is still a draft"
sleep 10
[ "$(ghr release view "$TAG" -R "$REPO" --json isDraft --jq .isDraft)" = false ] && ok "$TAG is public" || die "$TAG is still a draft"
git fetch --quiet origin --tags
[ "$(git rev-list -n 1 "$TAG")" = "$SHA" ] && ok "the tag $TAG = $SHA" || bad "the tag $TAG is not at $SHA"
[ "$(ghr api "repos/$REPO/releases/latest" --jq .tag_name)" = "$TAG" ] && ok "$TAG is the latest release" || bad "$TAG is not the latest release"
for f in $ALL_ASSETS; do
  code="$(curl -s -o /dev/null -L -r 0-0 -w '%{http_code}' "$BASE$f")"
  case "$code" in 200|206) ok "public: $BASE$f ($code)" ;; *) bad "public: $BASE$f answers $code" ;; esac
done
sleep 60
[ "$(assets_json | sort)" = "$BEFORE" ] && ok "no file of $TAG changed after publishing" || bad "a file of $TAG changed after publishing: compare with the digests above"
for f in latest-mac.yml latest.yml; do
  say "publik serves $f now: $(curl -s "https://publikhq.com/api/updates/$SLUG/$f" | sed -n "s/^version: //p" | head -1) (publik takes in new releases at 10:00 UTC)"
done
[ "$FAILS" -eq 0 ] || die "$FAILS check(s) after publishing failed (above)"
cd "$ROOT"
rm -r "$STATE"
ok "released: https://github.com/$REPO/releases/tag/$TAG"
