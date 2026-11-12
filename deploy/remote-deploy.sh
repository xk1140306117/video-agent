#!/usr/bin/env sh
set -eu

DEPLOY_DIR="$HOME/video-agent-deploy"
if [ "${1:-}" = "--built" ]; then
  ARCHIVE=""
  IMAGE="${2:?image tag is required}"
else
  ARCHIVE="${1:?image archive is required}"
  IMAGE="${2:?image tag is required}"
fi

CONTAINER="video-agent"
DATA_VOLUME="video-agent-data"
HOST_PORT="${VIDEO_AGENT_PORT:-3002}"

mkdir -p "$DEPLOY_DIR"

if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  CURRENT_IMAGE_ID="$(docker inspect --format='{{.Image}}' "$CONTAINER")"
  docker tag "$CURRENT_IMAGE_ID" video-agent:rollback
fi

if [ -n "$ARCHIVE" ]; then
  docker load -i "$ARCHIVE"
fi

ENV_ARGS=""
if [ -f "$DEPLOY_DIR/.env" ]; then
  ENV_ARGS="--env-file $DEPLOY_DIR/.env"
fi

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  -p "$HOST_PORT:3000" \
  -v "$DATA_VOLUME:/app/.video-agent" \
  $ENV_ARGS \
  "$IMAGE" >/dev/null

attempt=0
while [ "$attempt" -lt 18 ]; do
  status="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CONTAINER")"
  if [ "$status" = "healthy" ]; then
    if [ -n "$ARCHIVE" ]; then
      rm -f "$ARCHIVE"
    fi
    echo "DEPLOY_OK http://127.0.0.1:$HOST_PORT"
    exit 0
  fi
  if [ "$status" = "exited" ] || [ "$status" = "dead" ] || [ "$status" = "unhealthy" ]; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 5
done

echo "New container failed health check; starting rollback." >&2
docker logs --tail 100 "$CONTAINER" >&2 || true
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
if docker image inspect video-agent:rollback >/dev/null 2>&1; then
  docker run -d \
    --name "$CONTAINER" \
    --restart unless-stopped \
    -p "$HOST_PORT:3000" \
    -v "$DATA_VOLUME:/app/.video-agent" \
    $ENV_ARGS \
    video-agent:rollback >/dev/null
  echo "ROLLBACK_OK" >&2
fi
exit 1
