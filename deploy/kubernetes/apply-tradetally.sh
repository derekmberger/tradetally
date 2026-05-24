#!/usr/bin/env bash
# Idempotent install/upgrade for the TradeTally stack.
# Run from anywhere — script resolves its own dir.
# Re-runs are safe: kubectl apply is declarative, SOPS decryption is read-only,
# rollout waits are bounded.

set -euo pipefail

cd "$(dirname "$0")"
NAMESPACE=tradetally

echo "==> 1/8 namespace"
kubectl apply -f 00-namespace.yaml

echo "==> 2/8 SOPS-decrypted secrets"
sops -d tradetally-secrets.sops.yaml     | kubectl apply -f -
sops -d tradetally-oauth-keys.sops.yaml  | kubectl apply -f -

echo "==> 3/8 ConfigMap"
kubectl apply -f tradetally-config.yaml

echo "==> 4/8 Postgres (config → service → statefulset, explicit order)"
# Explicit ordering instead of `-f postgres/`: kubectl applies dir contents in
# lex order, which happens to be correct here, but enumerating files makes the
# dependency intent visible and future-proof against new files.
kubectl apply -f postgres/postgresql-config.yaml
kubectl apply -f postgres/service.yaml
kubectl apply -f postgres/statefulset.yaml

echo "==> 5/8 wait for Postgres ready (≤180s)"
kubectl rollout status statefulset/tradetally-db -n "$NAMESPACE" --timeout=180s

echo "==> 6/8 App (PVC → Deployment → Service → Ingress, explicit order)"
# PVC first so the Deployment's pod can immediately consume it; Service +
# Ingress order doesn't matter for traffic but matches the build-up sequence.
kubectl apply -f app/pvc-uploads.yaml
kubectl apply -f app/deployment.yaml
kubectl apply -f app/service.yaml
kubectl apply -f app/ingress.yaml

echo "==> 7/8 wait for app ready (≤600s — first boot runs 189 migrations + scheduler init)"
kubectl rollout status deployment/tradetally-app -n "$NAMESPACE" --timeout=600s

echo "==> 8/8 summary"
kubectl -n "$NAMESPACE" get pods,svc,ingress,pvc

cat <<'EOF'

DONE. Open https://tradetally.example.com/

Smoke checks:
  curl -sS https://tradetally.example.com/api/health | jq
  echo | openssl s_client -connect tradetally.example.com:443 -servername tradetally.example.com 2>/dev/null | openssl x509 -noout -issuer -subject -dates
EOF
