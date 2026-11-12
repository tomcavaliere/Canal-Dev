#!/bin/sh
# Lance les tests des règles Firestore dans l'émulateur (Java 21+ requis).
# Si le `java` par défaut est plus ancien, utilise le JDK 21 de Homebrew s'il est installé
# (sans changer le Java par défaut de la machine).
set -e
major=$(java -version 2>&1 | sed -n 's/.*version "\([0-9]*\).*/\1/p' | head -n 1)
if [ "${major:-0}" -lt 21 ] && command -v brew >/dev/null 2>&1; then
  jdk=$(brew --prefix openjdk@21 2>/dev/null || true)
  if [ -x "$jdk/bin/java" ]; then
    PATH="$jdk/bin:$PATH"
    export PATH
  fi
fi
exec firebase emulators:exec --only firestore --project demo-canal-dev "node --test tests/*.test.mjs"
