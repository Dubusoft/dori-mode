#!/usr/bin/env bash
# lane-sandbox (macOS): run a dori lane agent command inside a Seatbelt sandbox (sandbox-exec).
# Usage: lane-sandbox <cmd> [args...] | lane-sandbox --check | lane-sandbox --explain
# --explain prints what the profile a lane in the current directory would get (same environment, DORI_LANE_KEY defaulting
# to "explain") lets it touch, instead of running anything: one "<mode> <path>" line per profile path, where a later line
# wins at and below its path. Modes: rw, ro (readable, writes refused) and hide (reads and writes refused). Outside every
# line reads are allowed and writes refused; a * stands for one path component.
# Same inputs as the Linux (bubblewrap) lane-sandbox. A command runs only with DORI_LANE_KEY set (dori launch and the
# runner set it; the lead never runs behind this wrapper): without it the command is refused (exit 2), never run
# unsandboxed. Host paths come from the environment, colon-separated:
#   LANE_SANDBOX_RW      extra writable directories (e.g. your worktree root, a scratch dir; the runner's grants)
#   LANE_SANDBOX_RO      extra readable directories (the runner's grants); the ~/.dori/runner, ~/.ssh, credential
#                        and hide-list refusals come after them
#   LANE_SANDBOX_NO_CWD  directories too broad to make writable as the cwd (e.g. the parents of the worktree root)
#   DORI_LANE_TOKEN_FILE the lane's own token file, readable
#   LANE_SANDBOX_WORKTREES the runner's lane worktree root, made writable (the runner sets it from its policy)
#   LANE_SANDBOX_REPOS   the runner's repos root: the .git directory of each repo directly under it is made writable
#                        (hooks excluded), so a lane can fetch there and `git worktree add` into the worktree root
#
# Seatbelt cannot hide or remap paths the way bubblewrap does; it only refuses access (EPERM). So the profile allows
# reads almost everywhere and refuses writes outside $HOME and /opt/homebrew, which are writable but for what the host
# later runs or trusts outside the sandbox: what dori runs or trusts in ~/.dori (its runner dir, dori itself, its config,
# the scripts its secret commands run, the lead's cwd and the attachment pins), ~/.ssh, ~/Library/LaunchAgents, ~/Library/Keychains, the shell
# startup files, ~/.local/bin, ~/.bun/bin, ~/.cargo/bin, ~/.gitconfig and ~/.config/git and gh (HOST_RUN below),
# and the directories holding them (~, ~/.dori, ~/.config, ~/.local, ~/.bun, ~/.cargo, ~/Library) themselves, so none of them
# can be renamed away and replaced by a symlink. Writable again after those refusals: the cwd (worktree) and its git
# common dir, the runner's worktree root and the .git directories of the repos under its repos root, the lane's own
# TMPDIR, ~/.omo, ~/.cache, the lane's brief out dir, package caches, Xcode's per-user dirs, /tmp,
# Claude Code's lock dir, the user's login keychain file (and its atomic-write temp copies) and the terminal and null
# devices; the hooks of those git dirs stay refused. The rest of ~/.dori (~/.dori/research and ~/.dori/heavy among it)
# is writable like the rest of $HOME. ~/.dori is readable but for targeted refusals that come after every grant: ~/.dori/runner (but the runner's lane socket and bin and the lane's own brief, files, out dir, token and
# lanes/<key>, re-opened after it) and the credential stores in CREDENTIALS and MAC_CREDENTIALS below (~/.dori/env,
# secrets, state, lane-sandbox-hide and gateway-locks; cloud, kube, gpg, docker, git and registry logins, keyrings,
# browser profiles and cookie stores, shell history), refused for reads and writes alike; of ~/.dori/state only
# review-inputs is readable again. ~/.ssh is refused but for config, known_hosts and *.pub. ~/.config is readable but
# for its credential stores, gh's hosts.yml login among them: a lane gets GH_TOKEN only through its environment at launch (dori secret env), and
# gh runs with GH_CONFIG_DIR in the lane's TMPDIR, holding a copy of ~/.config/gh/config.yml. /bin/ps and /usr/bin/log
# refuse to run sandboxed and run outside the profile. A unix socket connect is not a file read to
# Seatbelt, so sockets get their own rules: none under ~/.dori
# but the lane socket (sock/lane.d/lane), none under ~/.config but the ssh agent's when SSH_AUTH_SOCK lives there. herdr-core's (hc)
# state and runtime dirs and any other hc control socket (HC_SOCKET, the hc config's socket) are refused outright like
# the hide list below, as hc runs commands on the host for whoever reaches it.
# Host paths listed one per line in ~/.dori/lane-sandbox-hide ('#' starts a comment; the lead owns that file), ~/.dori's
# own entries included, are refused outright, reads, writes and socket connects alike, over every rule above. Every path
# is resolved first (macOS /var and /tmp are symlinks into /private) and reaches the profile as a -D parameter, never as
# profile text. An entry of either list may be a glob (* and ? within one path component, [...] a class): it becomes a
# regex refusing every path it matches and everything below one, whether it exists now or appears later; the part
# before the first glob component is resolved like a path.
# macOS ships bash 3.2: no ${x,,}, no {fd} redirections, and no empty "${array[@]}" under set -u.
set -eu

# LANE_SANDBOX_PROFILE (e.g. review) has no Seatbelt profile yet: review lanes are placed on local Linux only. Refused
# before anything else (--check and --explain too), so a profiled lane never runs here with the default write access.
if [ -n "${LANE_SANDBOX_PROFILE:-}" ]; then
  echo "lane-sandbox: LANE_SANDBOX_PROFILE=$LANE_SANDBOX_PROFILE is not supported on macOS (review lanes run on Linux only); refusing" >&2
  exit 2
fi

# Credential stores and secrets under $HOME no lane reads, files and directories alike (a lane gets a credential only
# through its environment at launch (dori secret env)); the Linux template and `dori doctor` use the same list. The profile refuses reads and
# writes of each after every grant, so ~/.config/gh/hosts.yml stays hidden.
# BEGIN CREDENTIALS (rendered from CREDENTIAL_DENY in src/lane-sandbox-install.ts; edit the list there)
CREDENTIALS=".dori/env .dori/secrets .dori/state .dori/lane-sandbox-hide .dori/gateway-locks .secrets .aws .azure
  .oci .kube .config/gcloud .config/doctl .config/hcloud .config/flyctl .config/helm .config/cloudflare .cloudflared
  .terraform.d/credentials.tfrc.json .vault-token .docker/config.json .config/containers/auth.json .gnupg
  .password-store .local/share/keyrings .local/share/gnome-keyring .local/share/kwalletd .config/age .age
  .config/sops .config/Bitwarden .config/keepassxc .config/1Password .git-credentials .netrc .pypirc
  .cargo/credentials .cargo/credentials.toml .gem/credentials .m2/settings.xml .gradle/gradle.properties
  .config/composer/auth.json .yarnrc .yarnrc.yml .pnpmrc .npmrc .config/pnpm/auth.ini .config/glab-cli .nuget/NuGet
  .config/gh/hosts.yml .local/share/toodo-server .mozilla .config/google-chrome .config/chromium
  .config/BraveSoftware .config/microsoft-edge .config/discord .config/Slack .config/Signal
  .local/share/TelegramDesktop .config/Code/User/globalStorage .vscode .vscode-server .*_history .lesshst"
# END CREDENTIALS
# The macOS browser cookie and login stores, refused like CREDENTIALS. Their paths hold spaces, which the
# space-separated CREDENTIALS list cannot carry.
MAC_CREDENTIALS=(
  "Library/Application Support/Google/Chrome/*/Cookies"
  "Library/Application Support/Google/Chrome/*/Login Data"
  "Library/Cookies"
)

# What the host later runs or trusts outside the sandbox, under $HOME: refused for writes after the $HOME write grant.
# The lane's brief out dir and the login keychain file are writable again after it. An entry may be a glob, like the
# CREDENTIALS ones (config.json* covers dori's config and its backups, existing or not).
HOST_RUN=".dori/runner .dori/bin .dori/src .dori/dori-boot-prep.sh .dori/config.json* .dori/ops .dori/lead
  .dori/lane-attachments .dori/worktrees .ssh Library/LaunchAgents Library/Keychains .bashrc .bash_profile .bash_login .bash_logout .profile
  .zshrc .zprofile .zshenv .zlogin .zlogout .local/bin .bun/bin .cargo/bin .gitconfig .config/git .config/gh
  .config/herdr-core"
# The directories holding HOST_RUN entries, refused as themselves only: renaming one away would leave its old path free
# for a symlink into a writable directory.
HOST_RUN_PARENTS=". .dori .config .local .bun .cargo Library"

SBX=/usr/bin/sandbox-exec
# macOS's own OpenSSL-format root bundle (what curl and git use by default).
CERTS=/etc/ssl/cert.pem

# The real path of $1, which need not exist (a missing tail is appended to its nearest existing parent).
canon() {
  local p=$1 d b t
  if [ -d "$p" ]; then
    (cd "$p" && pwd -P)
    return
  fi
  d=$(dirname "$p")
  b=$(basename "$p")
  if [ -L "$p" ]; then
    t=$(readlink "$p")
    case "$t" in /*) canon "$t" ;; *) canon "$d/$t" ;; esac
    return
  fi
  d=$(canon "$d") || return 1
  if [ "$d" = / ]; then printf '/%s\n' "$b"; else printf '%s/%s\n' "$d" "$b"; fi
}

# $1's parent resolved, its last component kept: the path a symlink is reached by.
canon_parent() { printf '%s/%s\n' "$(canon "$(dirname "$1")")" "$(basename "$1")"; }

# $1 with every regex metacharacter escaped.
re_escape() { printf '%s' "$1" | sed 's/[][\.*^$+?(){}|]/\\&/g'; }

# glob_regex PATH: sets GLOB_RE to the anchored regex for the glob PATH and everything below a match (* and ? stay
# within one component, [...] is a class, [!...] a negated one) and GLOB_SHOW to PATH with its literal head resolved.
glob_regex() {
  local d=$1 rest="" re="" c i=0 j n cls
  while case "$d" in *[*?[]*) true ;; *) false ;; esac; do
    rest="/$(basename "$d")$rest"
    d=$(dirname "$d")
  done
  d=$(canon "$d")
  if [ "$d" = / ]; then d=""; fi
  n=${#rest}
  while [ "$i" -lt "$n" ]; do
    c=${rest:$i:1}
    case "$c" in
      '*') re="$re[^/]*" ;;
      '?') re="$re[^/]" ;;
      '[')
        # A class runs to the first ] after its first member; with none it is a literal [.
        j=$((i + 1))
        cls=""
        if [ "${rest:$j:1}" = '!' ] || [ "${rest:$j:1}" = '^' ]; then cls="^" && j=$((j + 1)); fi
        if [ "${rest:$j:1}" = ']' ]; then cls="$cls]" && j=$((j + 1)); fi
        while [ "$j" -lt "$n" ] && [ "${rest:$j:1}" != ']' ]; do
          if [ "${rest:$j:1}" != / ]; then cls="$cls${rest:$j:1}"; fi
          j=$((j + 1))
        done
        if [ "$j" -lt "$n" ]; then
          re="$re[$cls]"
          i=$j
        else
          re="$re\\["
        fi
        ;;
      '.' | '\' | '^' | '$' | '+' | '(' | ')' | '{' | '}' | '|' | ']') re="$re\\$c" ;;
      *) re="$re$c" ;;
    esac
    i=$((i + 1))
  done
  GLOB_RE="^$(re_escape "$d")$re(/|\$)"
  GLOB_SHOW="$d$rest"
}

# deny_target NAME PATH: sets TARGET to the SBPL filter for PATH (a subpath, or a regex for a glob) as parameter NAME,
# and SHOWN to the path --explain lists.
deny_target() {
  case "$2" in
    *[*?[]*)
      glob_regex "$2"
      param_raw "$1" "$GLOB_RE"
      SHOWN=$GLOB_SHOW
      TARGET="(regex (param \"$1\"))"
      ;;
    *)
      param "$1" "$2"
      SHOWN=$LAST
      TARGET="(subpath (param \"$1\"))"
      ;;
  esac
}

# Splits $1 on ':' into SPLIT, without globbing.
split_paths() { local IFS=:; set -f; SPLIT=($1); set +f; }

H="${HOME:?}"
H=$(canon "$H")
key=${DORI_LANE_KEY:-}
key=${key//[^A-Za-z0-9._-]/_}
case "$key" in . | ..) key="_$key" ;; esac

# The profile and its -D parameters for the lane in $key with working directory $C and TMPDIR $LT (set by the caller).
# Fills the globals PROFILE and PARAMS.
build_profile() {
  local n=0 p w_rules="" r_rules="" o_rules="" d_rules="" g_rules="" h_rules="" a_rules="" gcd broad kc rr
  local u_rules="" l_rules=""
  PARAMS=()
  # param NAME PATH: adds -D NAME=<real path of PATH>.
  # The paths --explain lists, each as resolved for its parameter (LAST is the last one param resolved).
  XW=() XR=() XO=() XHOOKS=() XCRED=() XHIDE=() XRUN=() XREPOS=
  param() { LAST=$(canon "$2"); PARAMS+=(-D "$1=$LAST"); }
  param_raw() { PARAMS+=(-D "$1=$2"); }
  w() { param "W$n" "$1"; XW+=("$LAST"); w_rules="$w_rules (subpath (param \"W$n\"))"; n=$((n + 1)); }
  r() { param "R$n" "$1"; XR+=("$LAST"); r_rules="$r_rules (subpath (param \"R$n\"))"; n=$((n + 1)); }
  # o PATH: one of the lane's own entries under ~/.dori/runner, readable again after the runner refusal.
  o() { param "O$n" "$1"; XO+=("$LAST"); o_rules="$o_rules (subpath (param \"O$n\"))"; n=$((n + 1)); }

  param HOME_DIR "$H"
  XHOME=$LAST
  param HOMEBREW /opt/homebrew
  XHOMEBREW=$LAST
  set -f
  for p in $HOST_RUN; do
    deny_target "U$n" "$H/$p"
    XRUN+=("$SHOWN")
    u_rules="$u_rules $TARGET"
    n=$((n + 1))
  done
  set +f
  for p in $HOST_RUN_PARENTS; do
    param "L$n" "$H/$p"
    l_rules="$l_rules (literal (param \"L$n\"))"
    n=$((n + 1))
  done

  w "$LT"
  for p in "$H/.omo" "$H/.cache" "$H/.npm" "$H/.bun/install/cache" \
    "$H/.cargo/registry" "$H/.cargo/git" "$H/Library/Caches" "$H/Library/Developer" /tmp; do
    w "$p"
  done
  # Claude Code's lock files: its processes take them so only one refreshes an account's OAuth token at a time.
  w "$H/.local/state/claude"
  # The login keychain, where Claude Code (through /usr/bin/security) stores a refreshed OAuth token; without it the
  # rotated token is lost. securityd rewrites the file atomically: a full copy as login.keychain-db.sb-<random> in the
  # same directory, then a rename over the original, so both names need writes. It is not SQLite (no -journal, -wal or
  # -shm), and nothing else in Keychains, nor another user's keychain, is opened.
  kc=$(canon "$H/Library/Keychains/login.keychain-db")
  XKEYCHAIN=$kc
  param_raw KEYCHAIN "$kc"
  param_raw KEYCHAIN_TMP "^$(re_escape "$kc")[.]sb-[^/]+\$"
  # Per-user temp and cache dirs under /var/folders (Xcode, clang module cache and other Apple tools use these, not TMPDIR).
  for p in "$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || :)" "$(getconf DARWIN_USER_CACHE_DIR 2>/dev/null || :)"; do
    if [ -n "$p" ]; then w "$p"; fi
  done
  split_paths "${LANE_SANDBOX_RW:-}"
  for p in ${SPLIT[@]+"${SPLIT[@]}"}; do
    if [ -n "$p" ]; then w "$p"; fi
  done
  # A lane started without --cwd makes its worktree from a repo under reposRoot into the worktree root: the new
  # worktree, and the repo's .git (refs, objects, FETCH_HEAD, worktrees/<name>), but not the repo's working tree.
  if [ -n "${LANE_SANDBOX_WORKTREES:-}" ]; then w "$LANE_SANDBOX_WORKTREES"; fi
  if [ -n "${LANE_SANDBOX_REPOS:-}" ]; then
    XREPOS=$(canon "$LANE_SANDBOX_REPOS")
    rr=$(re_escape "$XREPOS")
    param_raw REPOS_GIT "^$rr/[^/]+/[.]git(/|\$)"
    param_raw REPOS_HOOKS "^$rr/[^/]+/[.]git/hooks(/|\$)"
    g_rules="(allow file-write* (regex (param \"REPOS_GIT\")))"
    d_rules="(deny file-write* (regex (param \"REPOS_HOOKS\")))"
  fi

  broad=0
  case "$C" in / | /Users | "$H") broad=1 ;; esac
  split_paths "${LANE_SANDBOX_NO_CWD:-}"
  for p in ${SPLIT[@]+"${SPLIT[@]}"}; do
    if [ -n "$p" ] && [ "$C" = "$(canon "$p")" ]; then broad=1; fi
  done
  if [ "$broad" = 1 ]; then
    if [ -n "$key" ]; then echo "lane-sandbox: warning: cwd $C is too broad; not making it writable" >&2; fi
  else
    w "$C"
    if gcd=$(git -C "$C" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) && [ -d "$gcd" ]; then
      w "$gcd"
      # A hook written by a lane would run outside the sandbox at the next git command on the host.
      param HOOKS "$gcd/hooks"
      XHOOKS+=("$LAST")
      d_rules="$d_rules (deny file-write* (subpath (param \"HOOKS\")))"
    fi
  fi

  o "$H/.dori/runner/sock/lane.d"
  o "$H/.dori/runner/bin"
  o "$H/.dori/runner/briefs/$key.md"
  if [ -n "${DORI_LANE_TOKEN_FILE:-}" ]; then o "$DORI_LANE_TOKEN_FILE"; fi
  o "$H/.dori/runner/briefs/$key.files"
  o "$H/.dori/runner/briefs/$key.out"
  w "$H/.dori/runner/briefs/$key.out"
  # A lane started without --cwd works in ~/.dori/runner/lanes/<key>: readable here, writable as the cwd above.
  if [ -n "$key" ]; then o "$H/.dori/runner/lanes/$key"; fi
  split_paths "${LANE_SANDBOX_RO:-}"
  for p in ${SPLIT[@]+"${SPLIT[@]}"}; do
    if [ -n "$p" ]; then r "$p"; fi
  done

  param DORI "$H/.dori"
  param DORI_RUNNER "$H/.dori/runner"
  param DORI_BRIEFS "$H/.dori/runner/briefs"
  XDORI_RUNNER=$(canon "$H/.dori/runner")
  param DORI_LANES "$H/.dori/runner/lanes"
  param SSH "$H/.ssh"
  XSSH=$LAST
  param_raw SSH_PUB "^$(re_escape "$XSSH")/[^/]+[.]pub\$"
  param SSH_CONFIG "$H/.ssh/config"
  param SSH_KNOWN_HOSTS "$H/.ssh/known_hosts"
  param DORI_SECRETS "$H/.dori/secrets"
  XDORI_SECRETS=$LAST
  param DOCKER_HOME "$H/.docker/run/docker.sock"
  param DOCKER_VAR /var/run/docker.sock
  param_raw DOCKER_VAR_LINK "$(canon_parent /var/run/docker.sock)"
  param LANE_SOCK "$H/.dori/runner/sock/lane.d/lane"
  param CONFIG "$H/.config"
  param REVIEW_INPUTS "$H/.dori/state/review-inputs"
  XREVIEW_INPUTS=$LAST
  # SSH_AUTH_SOCK may name a symlink under ~/.config to the agent's socket: both names stay usable.
  case "${SSH_AUTH_SOCK:-}" in
    "$H"/.config/*)
      param AGENT_SOCK "$SSH_AUTH_SOCK"
      param_raw AGENT_LINK "$(canon_parent "$SSH_AUTH_SOCK")"
      a_rules="(allow network-outbound (remote unix-socket (path-literal (param \"AGENT_SOCK\"))) (remote unix-socket (path-literal (param \"AGENT_LINK\"))))"
      ;;
  esac
  local c_rules="" creds
  # Split without globbing: a glob entry becomes a regex under $H, never a match against the cwd here.
  set -f
  creds=($CREDENTIALS)
  set +f
  for p in "${creds[@]}"; do
    deny_target "CRED$n" "$H/$p"
    XCRED+=("$SHOWN")
    c_rules="$c_rules $TARGET"
    n=$((n + 1))
  done
  for p in "${MAC_CREDENTIALS[@]}"; do
    deny_target "CRED$n" "$H/$p"
    XCRED+=("$SHOWN")
    c_rules="$c_rules $TARGET"
    n=$((n + 1))
  done
  if [ -f "$H/.dori/lane-sandbox-hide" ]; then
    while IFS= read -r p || [ -n "$p" ]; do
      p=${p%%#*}
      p=$(printf '%s' "$p" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
      if [ -n "$p" ]; then
        deny_target "HIDE$n" "$p"
        XHIDE+=("$SHOWN")
        h_rules="$h_rules
(deny file-read* $TARGET)
(deny file-write* $TARGET)
(deny network-outbound (remote unix-socket $TARGET))"
        n=$((n + 1))
      fi
    done <"$H/.dori/lane-sandbox-hide"
  fi
  # herdr-core (hc): whoever reaches its control socket runs any command on the host, outside the sandbox (hc exec, hc
  # run), and its state dir holds every terminal's screen and the environment the core restarts terminals with. Refused
  # like the hide list: its state dir, its runtime dir under XDG_RUNTIME_DIR when set (where its sockets live), and each
  # socket HC_SOCKET, HC_TERMINAL_SOCKET or the hc config's socket names, with its holder sockets. The runner opens lane
  # terminals with hc from outside the sandbox; a lane reports its state over OSC 7501, terminal output, not the socket.
  local hc_paths hc_conf s
  hc_paths=("${XDG_STATE_HOME:-$H/.local/state}/herdr-core")
  if [ -n "${XDG_RUNTIME_DIR:-}" ]; then hc_paths+=("$XDG_RUNTIME_DIR/herdr-core"); fi
  hc_conf=${XDG_CONFIG_HOME:-$H/.config}/herdr-core/config.toml
  s=
  if [ -f "$hc_conf" ]; then
    s=$(sed -n "s/^[[:space:]]*socket[[:space:]]*=[[:space:]]*[\"']\([^\"']*\)[\"'].*/\1/p" "$hc_conf" | head -n 1)
    case "$s" in "~/"*) s=$H/${s#"~/"} ;; esac
  fi
  for p in "${HC_SOCKET:-}" "${HC_TERMINAL_SOCKET:-}" "$s"; do
    if [ -n "$p" ]; then hc_paths+=("$p" "${p%.sock}.holder.*.sock"); fi
  done
  for p in "${hc_paths[@]}"; do
    deny_target "HC$n" "$p"
    XHIDE+=("$SHOWN")
    h_rules="$h_rules
(deny file-read* $TARGET)
(deny file-write* $TARGET)
(deny network-outbound (remote unix-socket $TARGET))"
    n=$((n + 1))
  done

  # Later rules win over earlier ones in SBPL. Writes: the $HOME and Homebrew grant, then the HOST_RUN refusals, then
  # the specific write grants (which re-open the lane's out dir, a cwd-less lane's cwd and the login
  # keychain under them), then the credential and git hooks refusals over every grant. Reads: every read refusal comes
  # after the read grants (LANE_SANDBOX_RO): a grant never re-opens ~/.dori/runner, ~/.ssh or a credential store. Only
  # the lane's own runner entries are re-opened after the runner refusal, and ~/.dori/state/review-inputs after the
  # credential refusal.
  # realpath() of a directory opens it, and omo resolves every parent of its cwd: a cwd-less lane's parents are
  # ~/.dori/runner/lanes, ~/.dori/runner and ~/.dori (readable as a whole). The two under the runner get file-read-data
  # on the directory itself (the names of its entries), never on anything under it: the other lanes' files stay refused.
  # /bin/ps is setuid root, and a sandboxed process cannot exec a setuid binary; /usr/bin/log refuses to run sandboxed
  # ("Cannot run while sandboxed"). These two alone run outside the profile; they write nothing.
  PROFILE="(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath (param \"HOME_DIR\")) (subpath (param \"HOMEBREW\")))
(deny file-write*$u_rules)
(deny file-write*$l_rules)
(allow file-write*$w_rules)
$g_rules
(allow file-write* (literal (param \"KEYCHAIN\")) (regex (param \"KEYCHAIN_TMP\")))
(allow file-write* (literal \"/dev/null\") (literal \"/dev/zero\") (literal \"/dev/tty\") (literal \"/dev/ptmx\") (literal \"/dev/dtracehelper\") (regex #\"^/dev/ttys[0-9]+\$\") (regex #\"^/dev/fd/[0-9]+\$\"))
(deny file-write*$c_rules)
$d_rules
(allow file-read*$r_rules)
(allow process-exec (literal \"/bin/ps\") (literal \"/usr/bin/log\") (with no-sandbox))
(deny file-read* (subpath (param \"DORI_RUNNER\")))
(allow file-read*$o_rules)
(allow file-read-metadata (literal (param \"DORI_RUNNER\")) (literal (param \"DORI_BRIEFS\")) (literal (param \"DORI_LANES\")))
(allow file-read-data (literal (param \"DORI_RUNNER\")) (literal (param \"DORI_LANES\")))
(deny file-read* (subpath (param \"SSH\")))
(allow file-read-metadata (literal (param \"SSH\")))
(allow file-read* (literal (param \"SSH_CONFIG\")) (literal (param \"SSH_KNOWN_HOSTS\")) (regex (param \"SSH_PUB\")))
(deny file-read*$c_rules)
(allow file-read* (subpath (param \"REVIEW_INPUTS\")))
(deny network-outbound (remote unix-socket (subpath (param \"DORI\"))) (remote unix-socket (subpath (param \"CONFIG\"))))
(allow network-outbound (remote unix-socket (path-literal (param \"LANE_SOCK\"))))
$a_rules
(deny network-outbound (remote unix-socket (path-literal (param \"DOCKER_HOME\"))) (remote unix-socket (path-literal (param \"DOCKER_VAR\"))) (remote unix-socket (path-literal (param \"DOCKER_VAR_LINK\"))))
$h_rules
(deny file-read* (subpath (param \"DORI_SECRETS\")))
(deny file-write* (subpath (param \"DORI_SECRETS\")))
(deny network-outbound (remote unix-socket (subpath (param \"DORI_SECRETS\"))))
"
}

# The --explain table of the profile build_profile made, in the profile's own order so a later line wins as a later rule
# does: the read grants, $HOME and Homebrew, what the host runs, the writable paths, then the refusals that come after
# them and what each re-opens. The HOST_RUN_PARENTS refusals guard one directory entry each, not a tree, and are left out.
explain_profile() {
  local p q m
  echo "# lane-sandbox --explain (seatbelt) for lane $key in $C: reads are allowed and writes refused outside these lines; a later line wins at and below its path"
  for p in ${XR[@]+"${XR[@]}"}; do echo "ro $p"; done
  echo "rw $XHOME"
  echo "rw $XHOMEBREW"
  for p in "${XRUN[@]}"; do echo "ro $p"; done
  for p in ${XW[@]+"${XW[@]}"}; do echo "rw $p"; done
  echo "rw $XKEYCHAIN"
  if [ -n "$XREPOS" ]; then
    echo "rw $XREPOS/*/.git"
    echo "ro $XREPOS/*/.git/hooks"
  fi
  for p in ${XHOOKS[@]+"${XHOOKS[@]}"}; do echo "ro $p"; done
  # The runner refusal is a read refusal: the lane's own entries the profile also makes writable (its out dir, a
  # cwd-less lane's cwd) are rw again.
  echo "hide $XDORI_RUNNER"
  for p in ${XO[@]+"${XO[@]}"}; do
    m=ro
    for q in ${XW[@]+"${XW[@]}"}; do
      if [ "$q" = "$p" ]; then m=rw; fi
    done
    echo "$m $p"
  done
  echo "hide $XSSH"
  echo "ro $XSSH/config"
  echo "ro $XSSH/known_hosts"
  echo "ro $XSSH/*.pub"
  for p in ${XCRED[@]+"${XCRED[@]}"}; do echo "hide $p"; done
  echo "ro $XREVIEW_INPUTS"
  for p in ${XHIDE[@]+"${XHIDE[@]}"}; do echo "hide $p"; done
  echo "hide $XDORI_SECRETS"
}

# --explain: the table of the profile a lane here would get, built by the same build_profile (see the header).
if [ "${1:-}" = "--explain" ]; then
  key=${key:-explain}
  LT=$(canon "$H/.cache/omo-tmp/lane-sandbox/$key")
  C=$(pwd -P)
  build_profile
  explain_profile
  exit 0
fi

# --check: preflight for `dori doctor` and the runner. Runs before the usage and DORI_LANE_KEY refusal below so it
# also answers on the lead; exit 3 (not 2) keeps "no sandbox here" apart from a usage error. It runs `true` under the
# same profile a lane gets, so a profile this macOS refuses is caught before a lane's pane opens.
if [ "${1:-}" = "--check" ]; then
  if [ ! -x "$SBX" ]; then
    echo "lane-sandbox: $SBX not found" >&2
    exit 3
  fi
  C=/
  key=
  LT="$H/.cache/omo-tmp/lane-sandbox/_check"
  build_profile
  if ! err=$("$SBX" -p "$PROFILE" "${PARAMS[@]}" /usr/bin/true 2>&1); then
    echo "lane-sandbox: sandbox-exec cannot create a sandbox: ${err//$'\n'/ }" >&2
    exit 3
  fi
  echo "DORI_LANE_FILES=1"
  exit 0
fi

if [ "$#" -eq 0 ]; then
  echo "usage: lane-sandbox <cmd> [args...] | --check | --explain" >&2
  exit 2
fi

if [ -z "${DORI_LANE_KEY:-}" ]; then
  echo "lane-sandbox: DORI_LANE_KEY is not set; refusing to run $1 unsandboxed (set DORI_LANE_KEY=<key>, or use --explain or --check)" >&2
  exit 2
fi

LT="$H/.cache/omo-tmp/lane-sandbox/${key:?}"
mkdir -p "$LT" "$H/.dori/heavy"
chmod 700 "$LT"
LT=$(canon "$LT")
# gh reads its login from hosts.yml, which stays refused, and Seatbelt cannot put an empty file in its place: gh gets a
# config dir of its own in TMPDIR with a copy of config.yml (aliases, settings), and GH_TOKEN from its environment (dori secret env at launch). The
# dir is made fresh each start, so nothing a lane left there (a symlink included) is written through.
if [ -z "${GH_CONFIG_DIR:-}" ]; then
  rm -rf "$LT/gh"
  mkdir -m 700 "$LT/gh"
  if [ -f "$H/.config/gh/config.yml" ]; then cp "$H/.config/gh/config.yml" "$LT/gh/config.yml"; fi
  export GH_CONFIG_DIR="$LT/gh"
fi
C=$(pwd -P)
build_profile

export LANE_SANDBOX_ACTIVE=1 TMPDIR="$LT"
# Nor does a lane learn where herdr-core's (hc) control socket is (the profile refuses its sockets above).
unset HC_SOCKET HC_SESSION HC_TERMINAL_SOCKET HC_TERMINAL_ID HC_SCOPE
# omo starts its engine with an empty OpenSSL bundle (SSL_CERT_FILE/SSL_CERT_DIR under ~/.omo/engine-trust/defaults)
# and its agent shell inherits it, so curl, git and gh there fail every TLS verification. With SSL_CERT_FILE already
# set omo keeps it and only adds its own roots for itself; the system bundle is what these tools read by default.
if [ -z "${SSL_CERT_FILE:-}" ] && [ -f "$CERTS" ]; then export SSL_CERT_FILE="$CERTS"; fi
# omo wraps its memory reflection child in a sandbox-exec of its own, and macOS refuses to apply a sandbox inside this
# one ("sandbox_apply: Operation not permitted"). The omo profile dori-lane, which `dori runner install` adds to
# ~/.omo/omo.jsonc, turns that inner sandbox off: the reflection child still runs inside this profile. An OMO_PROFILE
# already set is kept.
if [ -z "${OMO_PROFILE:-}" ]; then export OMO_PROFILE=dori-lane; fi
exec "$SBX" -p "$PROFILE" "${PARAMS[@]}" -- "$@"
