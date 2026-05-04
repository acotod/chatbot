#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
#  deploy.sh  — commit + push + deploy al servidor
#  Uso:  ./deploy.sh "mensaje de commit"
#        ./deploy.sh            (usa mensaje automático con fecha)
# ─────────────────────────────────────────────────────────────
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_HOST="144.91.114.49"
SERVER_PORT="51576"
SERVER_USER="root"
SERVER_PATH="/opt/chatbot"
COMMIT_MSG="${1:-"deploy: $(date '+%Y-%m-%d %H:%M')"}"

echo "▶  Directorio: $REPO_DIR"
echo "▶  Mensaje   : $COMMIT_MSG"
echo ""

# ── 1. Commit local ──────────────────────────────────────────
cd "$REPO_DIR"
git add -A
if git diff --cached --quiet; then
  echo "ℹ  Sin cambios locales. Continuando con el push..."
else
  git commit -m "$COMMIT_MSG"
  echo "✔  Commit creado"
fi

# ── 2. Push a GitHub ─────────────────────────────────────────
git push origin main
echo "✔  Push a GitHub completado"

# ── 3. Deploy en servidor ────────────────────────────────────
echo ""
echo "▶  Conectando al servidor $SERVER_HOST..."

ssh -o StrictHostKeyChecking=no -p "$SERVER_PORT" "$SERVER_USER@$SERVER_HOST" \
  "set -e
   cd $SERVER_PATH

   echo '-- Pull de GitHub --'
   git pull origin main

   echo '-- Rebuild y restart --'
   docker compose up --build -d 2>&1 | tail -20

   echo '-- Estado final --'
   docker compose ps --format 'table {{.Name}}\t{{.Status}}'
  "

echo ""
echo "✅  Deploy completado"
