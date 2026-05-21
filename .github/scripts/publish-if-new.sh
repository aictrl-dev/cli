#!/usr/bin/env bash
# publish-if-new.sh — pack-then-publish wrapper for the publish workflow.
#
# Tolerates ONLY "version already published" errors so reruns after a
# partial failure still succeed. Every other error (ENEEDAUTH, network,
# etc) fails loud. See issue #51 for the v0.3.1 / v0.3.2 silent-failure
# post-mortem that motivated this wrapper.
#
# Also resolves Bun-only protocols (`catalog:` and `workspace:`) to
# concrete semver before packing, so the published tarball is installable
# via plain `npm install`. See issue #72 for the v0.3.3 install-failure
# post-mortem that motivated this resolver.
#
# Usage:
#   .github/scripts/publish-if-new.sh <package-label>
#
# Env:
#   REPO_ROOT       — absolute path to repo root (where workspaces.catalog
#                     is defined). Defaults to `git rev-parse --show-toplevel`.
#   AICTRL_VERSION  — release version with no `v` prefix. Used to substitute
#                     `workspace:*` deps. Required only if the package being
#                     published actually has workspace deps after any prior
#                     strip step has run.
#
# Must be run from the package's working directory (where `npm pack` will
# produce the .tgz). The <package-label> is used only for log annotations
# (e.g. "@aictrl/util").

set -euo pipefail

label="${1:?Usage: publish-if-new.sh <package-label>}"

# Clean stale tarballs so we always publish the freshly packed one.
rm -f *.tgz

# Resolve Bun-only protocols (`catalog:`, `workspace:`) to concrete semver
# before packing. Plain `npm install` rejects both with EUNSUPPORTEDPROTOCOL,
# so any tarball that ships them is broken for npm consumers (and the AI
# Review workflow in this very repo). #72.
export REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel)}"
export AICTRL_VERSION="${AICTRL_VERSION:-}"
node -e "
  const fs = require('fs');
  const path = require('path');
  const root = JSON.parse(fs.readFileSync(path.join(process.env.REPO_ROOT, 'package.json'), 'utf8'));
  const catalog = (root.workspaces && root.workspaces.catalog) || {};
  const release = process.env.AICTRL_VERSION || '';
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const fields = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'];
  let touched = false;
  for (const field of fields) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const [name, version] of Object.entries(deps)) {
      if (version === 'catalog:') {
        if (!catalog[name]) {
          console.error('::error::' + field + '[' + name + '] is catalog: but root workspaces.catalog has no entry for it');
          process.exit(1);
        }
        deps[name] = catalog[name];
        touched = true;
      } else if (typeof version === 'string' && version.startsWith('workspace:')) {
        if (!release) {
          console.error('::error::' + field + '[' + name + '] is ' + version + ' but AICTRL_VERSION env var is not set');
          process.exit(1);
        }
        // All sibling @aictrl/* packages release in lockstep with AICTRL_VERSION.
        // If that ever stops being true, replace with a per-package lookup.
        deps[name] = release;
        touched = true;
      }
    }
  }
  if (touched) {
    fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
    console.log('::notice::resolved Bun-only protocol deps in ' + pkg.name + '@' + pkg.version);
  }
"

# `npm pack` reads only the on-disk package.json, unlike `bun pm pack` which
# re-injects workspace deps from the lockfile and silently ignores in-place
# manifest edits (publish.yml's "Strip bundled deps" step had no effect on
# v0.3.3 for this reason). #72.
npm pack

# Use nullglob array to avoid pipefail exit on no matches (ls *.tgz
# returns exit 2 when nothing matches, which pipefail propagates).
shopt -s nullglob
tarballs=(*.tgz)
shopt -u nullglob

if [ ${#tarballs[@]} -eq 0 ]; then
  echo "::error::npm pack produced no .tgz files in $(pwd)"
  exit 1
fi

if [ ${#tarballs[@]} -gt 1 ]; then
  echo "::warning::npm pack produced ${#tarballs[@]} .tgz files in $(pwd), publishing first: ${tarballs[0]}"
fi

tarball="${tarballs[0]}"

set +e
output=$(npm publish "$tarball" --access public --provenance 2>&1)
code=$?
set -e

echo "$output"

if [ $code -ne 0 ]; then
  if echo "$output" | grep -qE 'EPUBLISHCONFLICT|E409|cannot publish over|already published'; then
    echo "::notice::Tolerating 'already published' error for ${label}"
  else
    exit $code
  fi
fi
