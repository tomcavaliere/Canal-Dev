#!/bin/bash
# PreToolUse (Bash) : interdit à Claude tout « git push ». Seul l'utilisateur pousse, depuis son terminal.
cmd=$(jq -r '.tool_input.command // ""')
if printf '%s' "$cmd" | grep -Eq '(^|[^[:alnum:]_-])git([[:space:]]+-[^[:space:]]+([[:space:]]+[^-[:space:]][^[:space:]]*)?)*[[:space:]]+push([[:space:]]|$)'; then
  jq -n '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"git push est réservé à l’utilisateur. Ne pousse pas : indique-lui simplement que les commits sont prêts à être poussés."}}'
fi
exit 0
