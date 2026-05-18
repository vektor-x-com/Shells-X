#!/bin/sh
# Simulates a firewall doing port-forward to a backend host on a separate
# network. The shell container probes this container's IP — :80 is local
# (TTL N), :8443 is DNAT'd to fw-backend:6379 (TTL N+1).
set -e

# Resolve backend's container IP (DNAT rule needs a numeric address).
# fw-backend might not be ready yet on first start; retry briefly.
i=0
until BACKEND_IP=$(getent hosts fw-backend | awk '{print $1}'); [ -n "$BACKEND_IP" ] || [ $i -ge 30 ]; do
  sleep 1; i=$((i+1))
done
[ -z "$BACKEND_IP" ] && { echo "fw-backend unreachable"; exit 1; }
echo "fw-backend resolved to ${BACKEND_IP}"

# Local service on :80, so :80 vs :8443 on this IP gives a TTL delta when probed.
nginx

# DNAT :8443 → backend:6379. FORWARD accept + POSTROUTING MASQUERADE so the
# backend's reply finds its way back through us (the backend has no route to
# the frontend network otherwise).
iptables -t nat -A PREROUTING  -p tcp --dport 8443 -j DNAT --to-destination "${BACKEND_IP}:6379"
iptables        -A FORWARD     -p tcp -d "${BACKEND_IP}" --dport 6379 -j ACCEPT
iptables -t nat -A POSTROUTING -p tcp -d "${BACKEND_IP}" --dport 6379 -j MASQUERADE

echo "ready: :80 -> nginx (local), :8443 -> DNAT to ${BACKEND_IP}:6379"
tail -f /dev/null
