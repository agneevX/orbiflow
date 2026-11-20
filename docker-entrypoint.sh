#!/bin/sh
set -eu

DEFAULT_UID=1000
DEFAULT_GID=1000
PUID_VAL="${PUID:-$DEFAULT_UID}"
PGID_VAL="${PGID:-$DEFAULT_GID}"
TZ_VAL="${TZ:-UTC}"

# Validate PUID / PGID are positive non-zero integers (never run server as root)
case "$PUID_VAL" in
  ''|*[!0-9]*|0)
    echo "[orbiflow] Invalid or root PUID ('$PUID_VAL'); falling back to $DEFAULT_UID" >&2
    PUID_VAL="$DEFAULT_UID"
    ;;
esac

case "$PGID_VAL" in
  ''|*[!0-9]*|0)
    echo "[orbiflow] Invalid or root PGID ('$PGID_VAL'); falling back to $DEFAULT_GID" >&2
    PGID_VAL="$DEFAULT_GID"
    ;;
esac

export TZ="$TZ_VAL"
export HOME="/config"

# If container was already launched as non-root (e.g. `docker run --user 1000:1000`),
# ensure cache subdir exists if writable and exec directly.
if [ "$(id -u)" -ne 0 ]; then
  mkdir -p /config/cache 2>/dev/null || true
  exec "$@"
fi

# Configure container timezone when valid zoneinfo exists
if [ -n "$TZ_VAL" ] && [ -f "/usr/share/zoneinfo/$TZ_VAL" ]; then
  ln -snf "/usr/share/zoneinfo/$TZ_VAL" /etc/localtime
  echo "$TZ_VAL" > /etc/timezone
fi

# Reconcile non-root orbiflow user/group with requested PUID/PGID
CUR_ORBIFLOW_UID="$(id -u orbiflow 2>/dev/null || echo '')"
CUR_ORBIFLOW_GID="$(id -g orbiflow 2>/dev/null || echo '')"
if [ "$CUR_ORBIFLOW_UID" != "$PUID_VAL" ] || [ "$CUR_ORBIFLOW_GID" != "$PGID_VAL" ]; then
  if getent passwd orbiflow >/dev/null 2>&1; then
    deluser orbiflow 2>/dev/null || true
  fi
  if [ "$CUR_ORBIFLOW_GID" != "$PGID_VAL" ] && getent group orbiflow >/dev/null 2>&1; then
    delgroup orbiflow 2>/dev/null || true
  fi
fi

EXISTING_GROUP="$(getent group "$PGID_VAL" | cut -d: -f1 || true)"
if [ -z "$EXISTING_GROUP" ]; then
  addgroup -g "$PGID_VAL" -S orbiflow 2>/dev/null || true
  TARGET_GROUP="orbiflow"
else
  TARGET_GROUP="$EXISTING_GROUP"
fi

EXISTING_USER="$(getent passwd "$PUID_VAL" | cut -d: -f1 || true)"
if [ -z "$EXISTING_USER" ]; then
  adduser -u "$PUID_VAL" -S -D -H -h /config -s /sbin/nologin -G "$TARGET_GROUP" orbiflow 2>/dev/null || true
fi

# Ensure /config exists and fix ownership on every mismatched file or folder on startup
mkdir -p /config /config/cache
find /config \( ! -uid "$PUID_VAL" -o ! -gid "$PGID_VAL" \) -exec chown "${PUID_VAL}:${PGID_VAL}" {} + 2>/dev/null || chown -R "${PUID_VAL}:${PGID_VAL}" /config

echo "[orbiflow] Dropping privileges to UID=${PUID_VAL} GID=${PGID_VAL} TZ=${TZ_VAL}"
exec su-exec "${PUID_VAL}:${PGID_VAL}" "$@"
