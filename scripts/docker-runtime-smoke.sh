#!/usr/bin/env bash

set -euo pipefail

image="${1:-coforge:ci}"
container="coforge-ci-${GITHUB_RUN_ID:-$$}-${GITHUB_RUN_ATTEMPT:-0}"
config_volume="coforge-config-${GITHUB_RUN_ID:-$$}-${GITHUB_RUN_ATTEMPT:-0}"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker volume rm "$config_volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker volume create "$config_volume" >/dev/null
docker run --detach \
  --name "$container" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --mount "type=volume,src=$config_volume,dst=/var/lib/coforge" \
  --env COFORGE_DEMO_ANONYMOUS=0 \
  --env COFORGE_ANALYST_TOKEN=ci-analyst \
  "$image" >/dev/null

for _ in $(seq 1 45); do
  state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container")"
  if [[ "$state" == healthy ]]; then break; fi
  if [[ "$state" == unhealthy || "$state" == missing ]]; then
    docker inspect "$container"
    docker logs "$container"
    exit 1
  fi
  sleep 1
done

[[ "$(docker inspect --format '{{.State.Health.Status}}' "$container")" == healthy ]]
[[ "$(docker inspect --format '{{.Config.User}}' "$container")" == coforge ]]
docker exec "$container" node -e 'if (process.getuid() !== 10001 || process.getgid() !== 10001) process.exit(1)'
docker exec "$container" node -e "fetch('http://127.0.0.1:3000/api/live').then(async r=>{const j=await r.json();if(!r.ok||j.status!=='live')process.exit(1)}).catch(()=>process.exit(1))"
docker exec "$container" node -e "fetch('http://127.0.0.1:3000/api/health').then(async r=>{const j=await r.json();if(!r.ok||j.status!=='ok'||j.db!=='ready')process.exit(1)}).catch(()=>process.exit(1))"
docker exec "$container" node -e "fetch('http://127.0.0.1:3000/api/query',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer ci-analyst'},body:JSON.stringify({sql:'SELECT COUNT(*) AS cargo_count FROM cargoes'})}).then(async r=>{const j=await r.json();if(!r.ok||!j.ok||j.rows?.[0]?.cargo_count!==48)process.exit(1)}).catch(()=>process.exit(1))"
docker exec "$container" node -e "require('better-sqlite3'); require('./licenses/third-party/THIRD-PARTY-LICENSES.json')"
