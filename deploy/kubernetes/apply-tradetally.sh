#!/usr/bin/env bash
# Idempotent install/reapply for the TradeTally stack.
# Run from anywhere — the script resolves its own dir.
#
# Prereqs: create your real Secret YAMLs locally from the .example templates:
#   - tradetally-secrets.yaml          (copy + edit tradetally-secrets.example.yaml)
#   - tradetally-oauth-keys.yaml       (use `kubectl create secret generic … --dry-run=client -o yaml`)
#
# Both files MUST be present in this directory when the script runs.
# Do not commit them with real values.

set -euo pipefail

cd "$(dirname "$0")"
NAMESPACE=tradetally

if [[ ! -f tradetally-secrets.yaml ]]; then
  echo "ERROR: tradetally-secrets.yaml not found." >&2
  echo "  Copy tradetally-secrets.example.yaml → tradetally-secrets.yaml," >&2
  echo "  fill in DB_PASSWORD/JWT_SECRET/BROKER_ENCRYPTION_KEY, then re-run." >&2
  exit 1
fi
if [[ ! -f tradetally-oauth-keys.yaml ]]; then
  echo "ERROR: tradetally-oauth-keys.yaml not found." >&2
  echo "  Follow the generate-and-package instructions in" >&2
  echo "  tradetally-oauth-keys.example.yaml, then re-run." >&2
  exit 1
fi

echo "==> 1/8 namespace"
kubectl apply -f 00-namespace.yaml

echo "==> 2/8 secrets"
kubectl apply -f tradetally-secrets.yaml
kubectl apply -f tradetally-oauth-keys.yaml

echo "==> 3/8 ConfigMap"
kubectl apply -f tradetally-config.yaml

echo "==> 4/8 Postgres (config → service → statefulset, explicit order)"
kubectl apply -f postgres/postgresql-config.yaml
kubectl apply -f postgres/service.yaml
kubectl apply -f postgres/statefulset.yaml

echo "==> 5/8 wait for Postgres ready (≤180s)"
kubectl rollout status statefulset/tradetally-db -n "$NAMESPACE" --timeout=180s

echo "==> 6/8 App (PVC → Deployment → Service → Ingress, explicit order)"
kubectl apply -f app/pvc-uploads.yaml
kubectl apply -f app/deployment.yaml
kubectl apply -f app/service.yaml
kubectl apply -f app/ingress.yaml

echo "==> 7/8 wait for app ready (≤600s — first boot runs 189 migrations + scheduler init)"
kubectl rollout status deployment/tradetally-app -n "$NAMESPACE" --timeout=600s

echo "==> 8/8 summary"
kubectl -n "$NAMESPACE" get pods,svc,ingress,pvc

cat <<EOF

DONE. Open your configured Ingress host (set in app/ingress.yaml).

Smoke check:
  curl -sS https://<your-host>/api/health | jq
EOF
