#!/usr/bin/env bash
# Carga (o rota) las credenciales de Spotify en GitHub Actions Secrets, entorno `secrets` del
# repositorio. Interactivo; se puede repetir. Uso, desde WSL y en la raíz del repo:
#   bash scripts/setup-github-secrets.sh
# Requisitos: gh autenticado con permiso de administración del repo, Node 24 y `npm ci` hecho.
# Los valores se piden sin eco y viajan a `gh` por stdin: no quedan en el historial, en la línea de
# comandos ni en archivos. El script no imprime ningún valor.
set -euo pipefail
# shellcheck disable=SC2016 # las comillas invertidas de los mensajes son literales

REPO='matigaleanodev/365-tracks-api'
ENVIRONMENT='secrets'
cd "$(dirname "$0")/.."

say() { printf '\n%s\n' "$*"; }
ask() { local answer; read -r -p "$1 [s/N] " answer; [[ "$answer" == [sS] ]]; }
read_secret() {
  local value
  read -r -s -p "$1: " value
  printf '\n' >&2
  [[ -n "${value//[[:space:]]/}" ]] || { echo "Valor vacío: no se guardó nada." >&2; exit 1; }
  printf '%s' "$value"
}
set_secret() { printf '%s' "$2" | gh secret set "$1" --env "$ENVIRONMENT" --repo "$REPO" > /dev/null; }

command -v gh > /dev/null || { echo 'Falta GitHub CLI (gh): https://cli.github.com'; exit 1; }
gh auth status > /dev/null 2>&1 || { echo 'gh no está autenticado: corré `gh auth login`.'; exit 1; }
command -v node > /dev/null || { echo 'Falta Node 24 (ver .nvmrc).'; exit 1; }
[[ -d node_modules ]] || { echo 'Falta `npm ci` en la raíz del repo.'; exit 1; }

say "Repositorio destino: $REPO (entorno de GitHub \`$ENVIRONMENT\`)."
ask '¿Continuar?' || exit 0

# Deja un entorno limitado a `main` (política de ramas propia con `main` como única rama). El
# cuerpo JSON fija el resto de la configuración del entorno. Idempotente.
restrict_to_main() {
  local environment=$1 body=$2 names
  printf '%s' "$body" | gh api -X PUT "repos/$REPO/environments/$environment" --input - > /dev/null
  names=$(gh api "repos/$REPO/environments/$environment/deployment-branch-policies" \
    --jq '.branch_policies[] | "\(.type // "branch"):\(.name)"')
  if [[ -z "$names" ]]; then
    gh api -X POST "repos/$REPO/environments/$environment/deployment-branch-policies" \
      -f name=main -f type=branch > /dev/null
  elif [[ "$names" != 'branch:main' ]]; then
    echo "El entorno $environment admite otras ramas además de main; corregilo en Settings → Environments." >&2
    exit 1
  fi
}
ONLY_MAIN='{"protected_branches": false, "custom_branch_policies": true}'

restrict_to_main "$ENVIRONMENT" "{\"deployment_branch_policy\": $ONLY_MAIN}"
echo "Entorno $ENVIRONMENT listo (solo main, sin revisores)."

if ask '¿Quitar los revisores del entorno production (el merge del release autoriza el deploy)?'; then
  # Sin revisores, lo único que impide desplegar desde otra rama es que `plan` y `production` solo
  # acepten `main`, y que `main` solo cambie por PR.
  gh api "repos/$REPO/rules/branches/main" --jq '.[].type' | grep -qx pull_request ||
    { echo 'main no exige pull request: no se quitan los revisores.' >&2; exit 1; }
  wait_timer=$(gh api "repos/$REPO/environments/production" \
    --jq '[.protection_rules[]? | select(.type == "wait_timer") | .wait_timer][0] // 0')
  bypass=$(gh api "repos/$REPO/environments/production" --jq '.can_admins_bypass // true')
  restrict_to_main plan "{\"deployment_branch_policy\": $ONLY_MAIN}"
  restrict_to_main production \
    "{\"reviewers\": [], \"wait_timer\": $wait_timer, \"can_admins_bypass\": $bypass, \"deployment_branch_policy\": $ONLY_MAIN}"
  echo 'Entornos plan y production limitados a main; production sin revisores (wait timer conservado).'
fi

say 'Credenciales de la app de Spotify (Dashboard > tu app > Settings). No se muestran al escribir.'
client_id=$(read_secret 'SPOTIFY_CLIENT_ID')
client_secret=$(read_secret 'SPOTIFY_CLIENT_SECRET')
set_secret SPOTIFY_CLIENT_ID "$client_id"
set_secret SPOTIFY_CLIENT_SECRET "$client_secret"
echo 'SPOTIFY_CLIENT_ID y SPOTIFY_CLIENT_SECRET guardados.'

seed=()
if ask '¿Sembrar también Parameter Store ahora, con AWS_PROFILE=architect (para probar antes del release)?'; then
  aws sts get-caller-identity --profile architect > /dev/null ||
    { echo 'El perfil architect no tiene sesión: iniciá sesión con ese perfil y repetí.'; exit 1; }
  seed=(--store)
fi

if ask '¿Obtener un refresh token nuevo con la autorización OAuth de Spotify (recomendado)?'; then
  say 'Se abre un servidor local en 127.0.0.1:8888. Abrí la URL que aparece, con la cuenta dueña de la playlist.'
  # Asignaciones de entorno (no argumentos): los valores no aparecen en la lista de procesos.
  (
    if ((${#seed[@]})); then export AWS_PROFILE=architect AWS_REGION=us-east-1; fi
    SPOTIFY_CLIENT_ID="$client_id" SPOTIFY_CLIENT_SECRET="$client_secret" \
      node scripts/spotify-authorize.ts --github-secret "${seed[@]}"
  )
else
  refresh_token=$(read_secret 'SPOTIFY_REFRESH_TOKEN (existente)')
  set_secret SPOTIFY_REFRESH_TOKEN "$refresh_token"
  echo 'SPOTIFY_REFRESH_TOKEN guardado.'
  if ((${#seed[@]})); then
    SPOTIFY_CLIENT_ID="$client_id" SPOTIFY_CLIENT_SECRET="$client_secret" \
      SPOTIFY_REFRESH_TOKEN="$refresh_token" AWS_PROFILE=architect AWS_REGION=us-east-1 \
      node scripts/sync-spotify-secrets.ts
  fi
fi

say 'Listo. Cuando sync-secrets.yml y el rol tracks365-secrets estén en main, sincronizá con:'
echo "  gh workflow run sync-secrets.yml --repo $REPO --ref main"
echo "  gh run watch --repo $REPO \$(gh run list --repo $REPO --workflow sync-secrets.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
