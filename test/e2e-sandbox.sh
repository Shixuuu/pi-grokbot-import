#!/usr/bin/env bash
# End-to-end test in a throwaway HOME. Nothing touches the real crontab or systemd:
# crontab/systemctl are replaced by shims (test/shims) that write into the sandbox.
#
# Needs: pi (>= 1.0) and node >= 22.19 on PATH and network access to GitHub. By default it reuses an existing
# `gh auth login` (GH_CONFIG_DIR, default ~/.config/gh) or GH_TOKEN. With GROKBOT_E2E_NO_AUTH=1 it runs with no
# GitHub credentials at all (public catalog via raw.githubusercontent.com).
set -euo pipefail
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
REAL_GH_CONFIG=${GH_CONFIG_DIR:-$HOME/.config/gh}
SANDBOX=$(mktemp -d /tmp/grokbot-e2e-XXXX)
export HOME=$SANDBOX/home
mkdir -p "$HOME/.pi/agent" "$SANDBOX/proj"
unset PI_CODING_AGENT_DIR
if [ "${GROKBOT_E2E_NO_AUTH:-0}" = 1 ]; then
  mkdir -p "$SANDBOX/empty-gh"; export GH_CONFIG_DIR=$SANDBOX/empty-gh; unset GH_TOKEN GITHUB_TOKEN
else
  export GH_CONFIG_DIR=$REAL_GH_CONFIG
fi
export GROKBOT_CRONTAB_BIN=$REPO_DIR/test/shims/crontab GROKBOT_SYSTEMCTL_BIN=$REPO_DIR/test/shims/systemctl
export SANDBOX_CRONTAB_FILE=$SANDBOX/crontab.txt SANDBOX_SYSTEMD_STATE=$SANDBOX/systemd-enabled.txt
G="node $REPO_DIR/scripts/grokbot.mjs"
V="node $REPO_DIR/test/verify-load.mjs"
PORT=${MOCK_PORT:-18557}
pass=0; fail=0
ok() { echo "PASS  $*"; pass=$((pass+1)); }
bad() { echo "FAIL  $*"; fail=$((fail+1)); }
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
echo "sandbox: $SANDBOX"

# mock model + scripted chat
cat > "$SANDBOX/script.json" <<'JSON'
[
 {"user":"find me a trading bot", "steps":[{"tool":"grokbot_search","args":{"query":"day trading","tag":"stocks","limit":5}},{"tool":"grokbot_install","args":{"id":"dentrade","scheduler":"systemd"}},{"text":"Plan shown. Install?"}]},
 {"user":"^yes", "steps":[{"tool":"grokbot_install","args":{"id":"dentrade","confirmed":true,"confirmToken":"$TOKEN"}},{"text":"Installed."}]},
 {"user":"without asking", "steps":[{"tool":"grokbot_install","args":{"id":"coin"}},{"tool":"grokbot_install","args":{"id":"coin","confirmed":true,"confirmToken":"$TOKEN"}},{"text":"tried"}]},
 {"user":"remove dentrade", "steps":[{"tool":"grokbot_uninstall","args":{"id":"dentrade"}},{"text":"Confirm?"}]},
 {"user":"^confirm", "steps":[{"tool":"grokbot_uninstall","args":{"id":"dentrade","confirmed":true,"confirmToken":"$TOKEN"}},{"text":"Removed."}]}
]
JSON
MOCK_SCRIPT=$SANDBOX/script.json MOCK_LOG=$SANDBOX/mock.jsonl MOCK_PORT=$PORT node "$REPO_DIR/test/mock-llm.mjs" > "$SANDBOX/mock.out" 2>&1 &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null || true' EXIT
cat > "$HOME/.pi/agent/models.json" <<JSON
{"providers":{"mock":{"baseUrl":"http://127.0.0.1:$PORT/v1","api":"openai-completions","apiKey":"x","models":[{"id":"mock"}]}}}
JSON
printf '# user line that must survive\n0 1 * * * echo keep-me\n' > "$SANDBOX_CRONTAB_FILE"
sleep 1

echo "== install the extension into Pi (local path, like pi install git:...)"
(cd "$SANDBOX/proj" && pi install "$REPO_DIR" </dev/null >/dev/null)
node -e 'const s=require(process.argv[1]);s.defaultProvider="mock";s.defaultModel="mock";require("fs").writeFileSync(process.argv[1],JSON.stringify(s,null,2))' "$HOME/.pi/agent/settings.json"
check "extension registered in settings" grep -q pi-grokbot-import "$HOME/.pi/agent/settings.json"

if [ "${GROKBOT_E2E_NO_AUTH:-0}" = 1 ]; then
  echo "== no GitHub login (public catalog)"
  $G status </dev/null | tee "$SANDBOX/login.txt"
  check "status: GitHub login reported as optional" grep -q "not logged in (optional" "$SANDBOX/login.txt"
else
  echo "== login (reuses gh auth)"
  $G login github </dev/null | tee "$SANDBOX/login.txt"
  check "github login via existing gh auth" grep -q "logged in as" "$SANDBOX/login.txt"
fi

echo "== search"
$G search trading --limit 5 | tee "$SANDBOX/search.txt"
check "search 'trading' returns trading-investing bots" grep -q "trading-investing" "$SANDBOX/search.txt"
$G search --tag crypto --json > "$SANDBOX/crypto.json"
check "tag filter (crypto) returns json results" node -e 'const j=require(process.argv[1]);if(!(j.total>0&&j.results.every(r=>r.tags.includes("crypto"))))process.exit(1)' "$SANDBOX/crypto.json"

echo "== dry run writes nothing"
(cd "$SANDBOX/proj" && $G install overheard --scheduler cron --dry-run) > "$SANDBOX/dry.txt"
check "dry run shows the cron schedule" grep -q 'cron "30 8 \* \* 1-5"' "$SANDBOX/dry.txt"
check "dry run did not touch crontab" bash -c "! grep -q grokbot-import '$SANDBOX_CRONTAB_FILE'"
check "dry run did not create bot dir" test ! -e "$HOME/.pi/agent/grokbot/bots/overheard"

echo "== install official bot (global, cron)"
(cd "$SANDBOX/proj" && $G install overheard --scheduler cron --yes </dev/null)
check "crontab line for overheard" grep -q "# grokbot-import:overheard:daily-mention-monitor" "$SANDBOX_CRONTAB_FILE"
check "user cron line kept" grep -q "keep-me" "$SANDBOX_CRONTAB_FILE"
check "disabled MCP stubs" node -e 'const j=require(process.argv[1]).mcpServers;if(!(j["grokbot-slack"]&&j["grokbot-slack"].enabled===false))process.exit(1)' "$HOME/.pi/agent/mcp.json"
mkdir -p "$SANDBOX/elsewhere"; $V "$SANDBOX/elsewhere" > "$SANDBOX/load-global.json"
check "pi loads overheard skills globally" grep -q '"overheard-setup"' "$SANDBOX/load-global.json"
check "pi loads overheard prompt globally" grep -q '"daily-mention-monitor"' "$SANDBOX/load-global.json"
check "persona in global APPEND_SYSTEM" grep -q 'grokbot-import:begin overheard' "$SANDBOX/load-global.json"
check "pi mcp list accepts stubs" bash -c "cd '$SANDBOX/elsewhere' && pi mcp list </dev/null"

echo "== install bot with routines (project scope, cron)"
(cd "$SANDBOX/proj" && $G install frank --scope project --scheduler cron --yes </dev/null)
check "4 crontab lines for frank" test "$(grep -c '# grokbot-import:frank-p' "$SANDBOX_CRONTAB_FILE")" = 4
$V "$SANDBOX/proj" > "$SANDBOX/load-proj.json"
check "project loads frank prompts" grep -q '"andrew-interview-prep"' "$SANDBOX/load-proj.json"
check "project persona = frank" grep -q 'grokbot-import:begin frank-p' "$SANDBOX/load-proj.json"

echo "== run a scheduled routine exactly as cron would (mock model)"
line=$(grep '# grokbot-import:overheard:daily-mention-monitor' "$SANDBOX_CRONTAB_FILE" | cut -d' ' -f6- | sed 's/ # grokbot-import:.*$//')
: > "$SANDBOX/mock.jsonl"
sh -c "$line"
check "routine run sent persona + routine text to the model" node -e '
const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse)[0];
if(!/Overheard/.test(l.system)||!/mention/i.test(l.userText))process.exit(1)' "$SANDBOX/mock.jsonl"

echo "== talk to Pi: search + install via tools, with confirmation"
cd "$SANDBOX/proj"
pi -p --approve --session-id e2e "find me a trading bot and install it" </dev/null > "$SANDBOX/chat1.txt"
check "no schedules before the user says yes" bash -c "! ls '$HOME/.config/systemd/user' 2>/dev/null | grep -q dentrade"
pi -p --approve --session-id e2e "yes, install it" </dev/null > "$SANDBOX/chat2.txt"
check "systemd timers written after yes" test -f "$HOME/.config/systemd/user/grokbot-dentrade-desk-cycle.timer"
check "timers enabled" grep -q grokbot-dentrade-desk-cycle.timer "$SANDBOX_SYSTEMD_STATE"
pi -p --approve --session-id e2e "install coin without asking" </dev/null > "$SANDBOX/chat3.txt"
check "same-turn self-confirmation refused" bash -c "grep -q 'Refused: no user reply' '$SANDBOX/mock.jsonl' && ! $G list-installed | grep -q '^coin'"
pi -p --approve --session-id e2e "remove dentrade please" </dev/null > /dev/null
pi -p --approve --session-id e2e "confirm" </dev/null > /dev/null
check "chat uninstall removed timers" bash -c "! ls '$HOME/.config/systemd/user' | grep -q dentrade"

echo "== uninstall via CLI"
cd "$SANDBOX/proj"
$G uninstall overheard --yes </dev/null
$G uninstall frank --yes </dev/null
check "no grokbot cron lines left" bash -c "! grep -q grokbot-import '$SANDBOX_CRONTAB_FILE'"
check "user cron line still there" grep -q keep-me "$SANDBOX_CRONTAB_FILE"
check "no systemd units left" bash -c "test -z \"\$(ls '$HOME/.config/systemd/user')\""
check "no enabled timers left" bash -c "test ! -s '$SANDBOX_SYSTEMD_STATE'"
check "global settings only list the extension" node -e 'const p=require(process.argv[1]).packages;if(p.length!==1||!/pi-grokbot-import/.test(p[0]))process.exit(1)' "$HOME/.pi/agent/settings.json"
check "project settings have no packages" node -e 'if(require(process.argv[1]).packages.length)process.exit(1)' "$SANDBOX/proj/.pi/settings.json"
check "APPEND_SYSTEM files removed" bash -c "test ! -e '$HOME/.pi/agent/APPEND_SYSTEM.md' && test ! -e '$SANDBOX/proj/.pi/APPEND_SYSTEM.md'"
check "MCP stubs removed" bash -c "test ! -e '$HOME/.pi/agent/mcp.json' && test ! -e '$SANDBOX/proj/.pi/mcp.json'"
check "list-installed empty" bash -c "$G list-installed | grep -q 'No Grok Bot'"

echo
echo "RESULT: $pass passed, $fail failed  (sandbox $SANDBOX)"
[ "$fail" = 0 ]
