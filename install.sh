#!/usr/bin/env bash
# Installs the dori-mode skill and the `dori` CLI, then runs `dori setup`.
# The repo is private: sign in to GitHub first (`gh auth login`, or GH_TOKEN with read access to the repo).
# Usage: bash -c "$(gh api -H 'Accept: application/vnd.github.raw' repos/Dubusoft/dori-mode/contents/install.sh)"
# Needs: git, gh, bun 1.3+. Optional env: DORI_REPO (owner/name), DORI_SRC (clone dir), SKILLS_DIR (where your agent loads skills).
set -euo pipefail

repo="https://github.com/${DORI_REPO:-Dubusoft/dori-mode}.git"
src="${DORI_SRC:-$HOME/.dori/src}"
skills="${SKILLS_DIR:-$HOME/.agents/skills}"

command -v bun >/dev/null || { echo "bun is required: https://bun.sh" >&2; exit 1; }
command -v git >/dev/null || { echo "git is required" >&2; exit 1; }
gh="$(command -v gh)" || { echo "gh is required to read the private repo: https://cli.github.com" >&2; exit 1; }
"$gh" auth status >/dev/null 2>&1 || { echo "sign in to GitHub first: gh auth login (or set GH_TOKEN)" >&2; exit 1; }

# git takes its GitHub credentials from gh (its login or GH_TOKEN), whatever helpers the global git config names. The
# clone keeps this in its own config, so every later `git pull` and `dori update` there authenticates the same way.
key="credential.https://github.com.helper"
helper="!$gh auth git-credential"
if [ -d "$src/.git" ]; then
  git -C "$src" config --unset-all "$key" || true
  git -C "$src" config --add "$key" ""
  git -C "$src" config --add "$key" "$helper"
  git -C "$src" pull --ff-only --quiet
else
  git -c "$key=" -c "$key=$helper" clone --quiet --depth 1 --config "$key=" --config "$key=$helper" "$repo" "$src"
fi

mkdir -p "$skills"
if [ -e "$skills/dori-mode" ] && [ ! -L "$skills/dori-mode" ]; then
  echo "$skills/dori-mode exists and is not a link; leaving it alone" >&2
else
  ln -sfn "$src/skills/dori-mode" "$skills/dori-mode"
fi

(cd "$src/skills/dori-mode/scripts" && bun install --silent && bun link --silent)

mkdir -p "$HOME/.dori"
dori="$(command -v dori || echo "$HOME/.bun/bin/dori")"

echo "Installed. Skill: $skills/dori-mode  CLI: $dori"
if [ -t 0 ]; then
  "$dori" setup
else
  echo "Next: run \`dori setup\` in a terminal (bot token, channels, autostart), then tell your agent: Dori mode"
fi
