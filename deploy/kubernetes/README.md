# Kubernetes deployment

Production-style Kubernetes manifests for self-hosting TradeTally on any
k8s cluster (tested on Talos Linux 1.13 / Kubernetes 1.36, but nothing here
is distro-specific).

This deployment was originally built for a homelab and copied here for
reuse. The full operator runbook is in [`RUNBOOK.md`](RUNBOOK.md).

## What you get

Single-replica deployment with a sidecar Postgres StatefulSet:

```
tradetally namespace (PSA: baseline)
├── Postgres 16.14-alpine StatefulSet (1 replica, 10Gi local-path PVC)
│   └── Headless Service for stable DNS (tradetally-db:5432)
└── Tradetally app Deployment (1 replica, Recreate strategy)
    ├── Uploads PVC (5Gi, RWO)
    ├── ConfigMap (~40 env vars, non-sensitive)
    ├── Secret 1: env vars (DB password, JWT, API keys)
    ├── Secret 2: OAuth2 RSA keypair (file-mounted)
    ├── ClusterIP Service (port 80)
    └── Ingress (TLS via cert-manager, body/timeout annotations tuned for the in-image nginx)
```

Why single-replica:
- The app runs ~14 in-process schedulers (price monitor, gamification,
  earnings, news, etc.) — two replicas would duplicate-fire every job.
- The uploads PVC is RWO; `Recreate` strategy is forced by physics (two
  pods can't multi-attach the same RWO volume).

## Prerequisites

| Requirement | Why |
|---|---|
| Kubernetes 1.30+ | PSA baseline + recent ingress-nginx + standard APIs |
| An ingress controller (nginx-ingress, traefik, etc.) | Routes inbound HTTPS |
| cert-manager OR pre-provisioned TLS | Real cert at `https://your-host.example.com/` |
| A default StorageClass | PVCs (10Gi postgres + 5Gi uploads) |
| `cluster-issuer` named `letsencrypt-prod` | Hardcoded in `app/ingress.yaml`; rename or change annotation if yours differs |

If you don't run cert-manager, swap the `cert-manager.io/cluster-issuer`
annotation in `app/ingress.yaml` for whatever your cluster provides.

## File layout

```
deploy/kubernetes/
├── 00-namespace.yaml                       # PSA baseline (needed: image's nginx master runs as root)
├── tradetally-config.yaml                  # ConfigMap — non-sensitive env vars
├── tradetally-secrets.example.yaml         # Secret template — generate real values, do NOT commit
├── tradetally-oauth-keys.example.yaml      # Secret template — generate RSA keypair, do NOT commit
├── postgres/
│   ├── postgresql-config.yaml              # Tuned conf (max_connections=200, shared_buffers=256MB, etc.)
│   ├── service.yaml                        # Headless ClusterIP
│   └── statefulset.yaml                    # postgres:16.14-alpine3.23
├── app/
│   ├── deployment.yaml                     # Single replica, Recreate, startupProbe-gated
│   ├── service.yaml                        # ClusterIP :80
│   ├── ingress.yaml                        # TLS + 150m body / 600s timeout
│   └── pvc-uploads.yaml                    # 5Gi RWO
├── apply-tradetally.sh                     # Idempotent install/reapply script
└── RUNBOOK.md                              # Full operator runbook
```

## Quick start

```bash
# 1. Change the hostname in tradetally-config.yaml + app/ingress.yaml from
#    `tradetally.example.com` to your real hostname.
#    Also: WEBAUTHN_RP_ID and SCHWAB_REDIRECT_URI in the ConfigMap.

# 2. Generate the secrets.
cp tradetally-secrets.example.yaml tradetally-secrets.yaml
# Edit tradetally-secrets.yaml — fill in DB_PASSWORD, JWT_SECRET, BROKER_ENCRYPTION_KEY:
DB_PASS=$(openssl rand -base64 32)
JWT=$(openssl rand -base64 48)
BROKER=$(openssl rand -hex 32)
# (paste these into the file's stringData section)

# 3. Generate the OAuth keypair.
openssl genrsa -out /tmp/oauth-private.pem 2048
openssl rsa -in /tmp/oauth-private.pem -pubout -out /tmp/oauth-public.pem
kubectl create namespace tradetally --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret generic tradetally-oauth-keys -n tradetally \
  --from-file=oauth-private.pem=/tmp/oauth-private.pem \
  --from-file=oauth-public.pem=/tmp/oauth-public.pem
shred -u /tmp/oauth-private.pem /tmp/oauth-public.pem 2>/dev/null || rm /tmp/oauth-private.pem /tmp/oauth-public.pem

# 4. Apply the rest.
kubectl apply -f 00-namespace.yaml
kubectl apply -f tradetally-secrets.yaml
kubectl apply -f tradetally-config.yaml
kubectl apply -f postgres/postgresql-config.yaml
kubectl apply -f postgres/service.yaml
kubectl apply -f postgres/statefulset.yaml
kubectl rollout status statefulset/tradetally-db -n tradetally --timeout=180s
kubectl apply -f app/pvc-uploads.yaml
kubectl apply -f app/deployment.yaml
kubectl apply -f app/service.yaml
kubectl apply -f app/ingress.yaml
kubectl rollout status deployment/tradetally-app -n tradetally --timeout=600s

# 5. Open https://your-host.example.com/
```

Or just run `bash apply-tradetally.sh` — but read it first since it assumes
your secrets are SOPS-encrypted at `tradetally-secrets.sops.yaml` and
`tradetally-oauth-keys.sops.yaml`. If you're using plain Secrets or a
different secret-management tool (sealed-secrets, external-secrets), edit
the `sops -d ... | kubectl apply -f -` lines accordingly.

## Important operator notes

These come up in real operation — see `RUNBOOK.md` for full detail.

1. **First-boot is slow** (~3-5 min): 189 migrations run sequentially before
   the backend binds to port 3000. The `startupProbe` has a 10-min budget;
   don't tighten it.
2. **Trade Grouping setting**: change in your User → Settings to ≤10 min
   (default 60 min silently merges close-together same-side round-trips,
   hiding losing legs from your trade history).
3. **`/api/health` always returns 200**; `.status` reads `DEGRADED` when
   `ENABLE_BACKUP_SCHEDULER=false`. This is expected. Monitor on the
   `.services.database` and `.services.storage` fields instead.
4. **WEBAUTHN_RP_ID is effectively write-once** — once any user registers
   a passkey, changing the hostname invalidates every existing passkey.
5. **`Recreate` deploy strategy** causes ~30-90s downtime on every upgrade.
   RWO PVC physics forces this; you can't do rolling updates without first
   moving uploads off-cluster (S3, B2, MinIO).

## Provenance / fork-specific patches

This `deploy/kubernetes/` tree was built against the homelab `homelab-patches`
branch of this fork. The image referenced in `app/deployment.yaml` is the
upstream `potentialmidas/tradetally:v2.6.8`; if you want this fork's bug
fixes (Schwab futures import + multi-section CSV parser), rebuild from
this branch:

```bash
docker buildx build --platform linux/amd64 \
  -t your.registry.example.com/tradetally:v2.6.8-patched \
  --push .
```

Then update the `image:` line in `app/deployment.yaml`.

What the fork branch fixes vs upstream `v2.6.8` (see commit history for details):

| Patch | Fixes |
|---|---|
| Futures detection + fee sign normalization | ES P&L was 50× too small, MES 5× too small; Net came out > Gross because Schwab exports fees as negative |
| Single-trade pointValue application | Grouped trades had correct math; single trades still defaulted to multiplier=1 |
| Multi-section Schwab Account Statement parser | Raw Schwab "Account Statement" exports (Cash Balance + Futures Statements + ... sections) now parse natively without preprocessing |

If/when these land upstream, the fork rebuild step goes away.
