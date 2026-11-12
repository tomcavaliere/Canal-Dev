#!/bin/bash
# Stop : s'il reste des modifications non commitées, demande à Claude de faire des commits atomiques avant de s'arrêter.
input=$(cat)
[ "$(printf '%s' "$input" | jq -r '.stop_hook_active // false')" = "true" ] && exit 0
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
changes=$(git status --porcelain)
[ -z "$changes" ] && exit 0
jq -n --arg c "$changes" '{decision:"block",reason:("Des modifications ne sont pas commitées :\n" + $c + "\n\nFais maintenant un ou plusieurs commits ATOMIQUES (un changement logique par commit) : d’abord `git add <fichiers>` dans une commande séparée, puis `git commit -m \"...\"` (message en français, à l’impératif, style du dépôt). Une revue automatique s’exécute avant chaque commit : si elle bloque, corrige les problèmes critiques signalés puis recommence. Ne fais JAMAIS de git push. Ne commite pas de fichiers qui n’ont rien à voir avec ton travail : signale-les plutôt à l’utilisateur.")}'
