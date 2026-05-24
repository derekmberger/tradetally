# Kubernetes deployment

Production-style Kubernetes manifests for self-hosting TradeTally on any
k8s cluster.

## What you get

```
tradetally namespace (PSA: baseline)
├── Postgres 16.14-alpine StatefulSet (1 replica, 10Gi PVC)
│   └── Headless Service for stable DNS (tradetally-db:5432)
└── Tradetally app Deployment (1 replica, Recreate strategy)
    ├── Uploads PVC (5Gi, RWO)
    ├── ConfigMap (non-sensitive env vars)
    ├── Secret: env vars (DB password, JWT, API keys)
    ├── Secret: OAuth2 RSA keypair (file-mounted)
    ├── ClusterIP Service (port 80)
    └── Ingress (TLS via cert-manager, body/timeout annotations tuned for
        the in-image nginx)
```

Why single-replica + Recreate:
- The app runs ~14 in-process schedulers (price monitor, gamification,
  earnings, news, etc.) — two replicas would duplicate-fire every job.
- The uploads PVC is RWO; `Recreate` strategy is forced by physics (two
  pods can't multi-attach the same RWO volume).

## Prerequisites

| Requirement | Why |
|---|---|
| Kubernetes 1.30+ | PSA baseline + standard APIs |
| An ingress controller (nginx-ingress, traefik, etc.) | Routes inbound HTTPS |
| cert-manager OR pre-provisioned TLS | Real cert at `https://<your-host>/` |
| A default StorageClass | PVCs (10Gi postgres + 5Gi uploads). Default uses `local-path`; edit the PVC specs if your cluster uses a different class. |
| `cluster-issuer` named `letsencrypt-prod` | Hardcoded in `app/ingress.yaml`; rename or change annotation if yours differs |

## File layout

```
deploy/kubernetes/
├── 00-namespace.yaml                       # PSA baseline (image's nginx master runs as root)
├── tradetally-config.yaml                  # ConfigMap — non-sensitive env vars
├── tradetally-secrets.example.yaml         # Template for runtime secrets; do NOT commit real values
├── tradetally-oauth-keys.example.yaml      # Template + instructions for OAuth2 RSA keypair
├── postgres/
│   ├── postgresql-config.yaml              # Tuned conf (max_connections=200, shared_buffers=256MB, etc.)
│   ├── service.yaml                        # Headless ClusterIP
│   └── statefulset.yaml                    # postgres:16.14-alpine3.23
├── app/
│   ├── deployment.yaml                     # Single replica, Recreate, startupProbe-gated
│   ├── service.yaml                        # ClusterIP :80
│   ├── ingress.yaml                        # TLS + 150m body / 600s timeout
│   └── pvc-uploads.yaml                    # 5Gi RWO
└── apply-tradetally.sh                     # Idempotent install/reapply script
```

## Setup

### 1. Pick your hostname

Search-and-replace `tradetally.example.com` with your real hostname in:
- `tradetally-config.yaml` (multiple fields: `INSTANCE_URL`, `APP_URL`,
  `BASE_URL`, `FRONTEND_URL`, `WEBAUTHN_RP_ID`, `SCHWAB_REDIRECT_URI`)
- `app/ingress.yaml` (`tls.hosts` and `rules.host`)

### 2. Generate the runtime Secret

```bash
cp tradetally-secrets.example.yaml tradetally-secrets.yaml
# Then edit tradetally-secrets.yaml — fill the three CHANGE_ME values:
openssl rand -base64 32   # → DB_PASSWORD
openssl rand -base64 48   # → JWT_SECRET
openssl rand -hex 32      # → BROKER_ENCRYPTION_KEY
```

Leave the rest as empty strings until you have the corresponding API key
(Finnhub, Gemini, Stripe, etc.) — empty-string is treated as unset by the
backend's env validator.

**Do not commit `tradetally-secrets.yaml` with real values.** If you need
version-controlled secrets, encrypt with SOPS / sealed-secrets /
external-secrets-operator before commit.

### 3. Generate the OAuth2 keypair

The mobile app's OAuth2/OIDC flow needs an RSA signing keypair. Generate
locally + create the Secret directly with kubectl:

```bash
openssl genrsa -out /tmp/oauth-private.pem 2048
openssl rsa -in /tmp/oauth-private.pem -pubout -out /tmp/oauth-public.pem

kubectl create namespace tradetally --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret generic tradetally-oauth-keys -n tradetally \
  --from-file=oauth-private.pem=/tmp/oauth-private.pem \
  --from-file=oauth-public.pem=/tmp/oauth-public.pem \
  --dry-run=client -o yaml > tradetally-oauth-keys.yaml

# Then either apply directly or encrypt before commit:
kubectl apply -f tradetally-oauth-keys.yaml

shred -u /tmp/oauth-private.pem /tmp/oauth-public.pem 2>/dev/null \
  || rm /tmp/oauth-private.pem /tmp/oauth-public.pem
```

### 4. Apply everything

```bash
bash apply-tradetally.sh
```

The script enforces the apply order (Postgres before app), waits for
each rollout, and prints a summary. Idempotent — safe to re-run after
edits.

If you'd rather drive it manually, the script body is short enough to
read top-to-bottom and copy what you want.

### 5. Open your hostname

`https://<your-host>/` should serve the app. First boot takes 3-5 minutes
(see operating notes below).

## Operating notes

These come up in real operation; document for the next person.

**First-boot is slow** (~3-5 min). 189 migrations run sequentially before
the backend binds to port 3000. The `startupProbe` in `app/deployment.yaml`
has a 10-min budget. Don't tighten without measuring.

**Trade Grouping setting.** Default is 60 minutes — silently merges
close-together same-side round-trips, which can hide losing legs from your
trade history. Set it to ≤10 minutes under your user's Settings → Trading
preferences to avoid this. (Partial fills, which fire in seconds, still
group correctly.)

**`/api/health` always returns HTTP 200**, even when `.status` is
`DEGRADED`. The status field reads `DEGRADED` whenever
`ENABLE_BACKUP_SCHEDULER=false` (which is the default in `tradetally-config.yaml`
because no off-cluster backup destination is configured). Don't alert on
`health.status`; alert on `health.services.database` and
`health.services.storage` instead.

**`WEBAUTHN_RP_ID` is effectively write-once.** Once any user registers a
passkey, the credential is cryptographically bound to that exact hostname.
Changing the hostname invalidates every existing passkey — browsers refuse
to use them on a new RP ID. Plan a passkey-reset migration if you must
change.

**`Recreate` deploy strategy = ~30-90s downtime on every upgrade.** RWO PVC
physics force this; rolling updates can't multi-attach. If you need zero
downtime, the cleanest path is moving uploads to object storage (S3, B2,
MinIO) — then `RollingUpdate` works because pods no longer share file
storage.

**Local-path PVCs (default StorageClass) pin pods to nodes.** If your
cluster uses `local-path` provisioner, the Postgres + uploads PVCs anchor
the pods to whichever node received the first scheduling. Node reboot
means the pod is Pending until the node returns. For multi-node
resilience, use a networked StorageClass (longhorn, ceph, etc.) instead.

**Password reset is impossible without SMTP** by default. Email/SMTP
secrets aren't populated by the example templates. With
`REGISTRATION_MODE=closed` and only the operator account, account
recovery is via direct `psql` access to the `users` table. Add the SMTP
secrets in `tradetally-secrets.yaml` to enable in-app password reset.

**`/api-docs` Swagger UI is enabled by default and reachable on whoever can
hit the Ingress.** Acceptable on LAN-only; tighten via Ingress auth
annotation if exposed publicly.

## Upgrade procedure

```bash
# 1. Bump the image tag in app/deployment.yaml
# 2. Re-apply
bash apply-tradetally.sh
```

Brief downtime (~30-90s) per the Recreate strategy. New migrations (if
any) run during the new pod's startup; the `startupProbe` covers this.

## Postgres maintenance

```bash
# Connect
kubectl -n tradetally exec -it tradetally-db-0 -- psql -U trader tradetally

# Backup (manual pg_dump)
kubectl -n tradetally exec tradetally-db-0 -- pg_dump -U trader tradetally \
  > backup-$(date +%Y%m%d).sql

# Restore (DESTRUCTIVE)
kubectl -n tradetally exec -i tradetally-db-0 -- psql -U trader tradetally \
  < backup-YYYYMMDD.sql

# View slow queries (top 10 by total time)
kubectl -n tradetally exec tradetally-db-0 -- psql -U trader tradetally -c \
  "SELECT round(total_exec_time::numeric, 1) AS total_ms, calls,
          round(mean_exec_time::numeric, 1) AS mean_ms, query
   FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10;"

# Apply postgresql.conf changes — restart picks up the new ConfigMap value
kubectl apply -f postgres/postgresql-config.yaml
kubectl rollout restart statefulset/tradetally-db -n tradetally
```

## Provenance

These manifests originated in a homelab Talos cluster deployment. The
`homelab-patches` branch of this fork carries source-level fixes for
Schwab futures imports + multi-section Account Statement parsing.

If you want the patched behavior, rebuild from this branch:

```bash
docker buildx build --platform linux/amd64 \
  -t your.registry.example.com/tradetally:<your-tag> \
  --push .
```

Then update the `image:` line in `app/deployment.yaml`.
