# TradeTally Runbook

App URL: <https://tradetally.example.com/>
Namespace: `tradetally`
Manifests: this directory
Spec: `docs/superpowers/specs/2026-05-23-tradetally-deployment-design.md`

## Day-to-day

Open the URL. Log in with the admin account you created on first launch
(stored in 1Password — entry "TradeTally (talos-homelab)").

Health JSON: `curl -sS https://tradetally.example.com/api/health | jq`
Note: HTTP code stays 200 even when `.status` is `DEGRADED`. Persistent
`DEGRADED` is expected with `ENABLE_BACKUP_SCHEDULER=false` — alert on
`.services.database` and `.services.storage` instead.

API docs (LAN-only): <https://tradetally.example.com/api-docs/>

## Reapply / re-install

```bash
bash talos/manifests/tradetally/apply-tradetally.sh
```

Idempotent. Safe to run any time.

## Importing Schwab statements

As of `v2.6.8-homelab.3` (homelab commit `191060f`), TradeTally natively
handles raw multi-section Schwab Account Statement exports. Upload the
file directly via the ThinkorSwim importer — no preprocessing needed.

**Required operator setting (one-time, per user profile):**
- Trade Grouping → time-gap = **10 minutes or less**. Default is 60min,
  which silently merges close-together same-side round-trips (e.g.,
  5/19 had two ES round-trips ~10min apart — at 60min they got averaged
  into one merged trade, hiding the losing leg).

**Bundled fixes in the homelab image** (vs upstream `potentialmidas/tradetally:v2.6.8`):
- v2.6.8-homelab.1: `/SYMBOL:EXCHANGE` futures contract detection + fee
  sign normalization (Schwab exports fees as negative; default math flipped Net > Gross)
- v2.6.8-homelab.2: applied futures `pointValue` in the single-trade P&L path
  (was correct only for grouped trades; singles defaulted to multiplier=1
  → ES P&L 50× too small)
- v2.6.8-homelab.3: native multi-section Schwab Account Statement parser
  (extracts TRD rows from Cash Balance + Futures Statements sections; v1
  scope does not yet handle Forex or Crypto sections — both empty in
  test data, code mapping not verifiable yet)

**Debug fallback** — `tools/sanitize-schwab-statement.py` (DEPRECATED, kept
for inspection/regression-fallback). Same transformation in Python:

```bash
python3 ~/GitHub/homelab/tools/sanitize-schwab-statement.py \
  ~/Downloads/MM-DD-YYYY-AccountStatement.csv \
  ~/Downloads/MM-DD-YYYY-AccountStatement-cleaned.csv
```

## Upgrade

```bash
# 1. Check upstream for new version
cd ~/GitHub/tradetally && git pull && git tag --sort=-creatordate | head -5
# 2. Edit the image tag in app/deployment.yaml (potentialmidas/tradetally:vX.Y.Z)
# 3. Reapply
bash talos/manifests/tradetally/apply-tradetally.sh
# 4. Verify migration set matches repo (gotcha #11)
kubectl exec deploy/tradetally-app -n tradetally -- ls /app/backend/migrations | wc -l
ls ~/GitHub/tradetally/backend/migrations | wc -l
# Both numbers must match. Drift = image was built from a different commit than the tag claims.
```

Do NOT remove `PORT: "3000"` from `tradetally-config.yaml` during an upgrade.
The image's in-baked nginx hardcodes `proxy_pass http://localhost:3000`; if
`PORT` is unset the joi default of 5001 takes over and the Ingress 502s.

## Fill in deferred secrets

Schwab / Stripe / email / etc. slots are reserved as empty strings in
`tradetally-secrets.sops.yaml`. To fill one in:

```bash
sops edit talos/manifests/tradetally/tradetally-secrets.sops.yaml
# (edit, save, exit)
sops -d talos/manifests/tradetally/tradetally-secrets.sops.yaml | kubectl apply -f -
kubectl rollout restart deploy/tradetally-app -n tradetally
```

The app reads env on boot — restart is required.

**SMTP / email caveat:** `EMAIL_PORT` is NOT pre-reserved as an empty slot
(it was removed during initial deployment — the app's joi env validator
rejects empty-string for numeric fields). When configuring SMTP later,
ADD `EMAIL_PORT: "587"` (or your provider's port) explicitly in the
`sops edit` session.

For Schwab specifically: register your TradeTally instance at developer.schwab.com,
set the redirect URI to exactly
`https://tradetally.example.com/api/broker-sync/connections/schwab/callback`
(must match the value already in `tradetally-config.yaml`). Mismatch = OAuth
callback fails.

## Rotate credentials

JWT_SECRET, DB_PASSWORD, OAuth keypair, BROKER_ENCRYPTION_KEY are all in SOPS.
Rotation:

- **DB_PASSWORD**: edit SOPS Secret AND set new password in Postgres
  (`ALTER USER trader WITH PASSWORD '...';`) AND restart the app (Postgres
  won't kick existing connections, but new ones use the new password).
- **JWT_SECRET**: edit SOPS Secret + restart app. All existing sessions
  invalidate — users re-log-in.
- **OAuth keypair**: edit SOPS file-Secret with new keys + restart app.
  Mobile OAuth clients with cached `.well-known/jwks.json` will need to
  refresh (typically automatic within 24h).
- **BROKER_ENCRYPTION_KEY**: do NOT rotate without first decrypting + re-encrypting
  all stored broker tokens in the DB. Otherwise every connected broker breaks.
  Plan rotation as a data migration, not a config change.

## Postgres maintenance

Connect: `kubectl -n tradetally exec -it tradetally-db-0 -- psql -U trader tradetally`

Manual `pg_dump`:
```bash
kubectl -n tradetally exec tradetally-db-0 -- pg_dump -U trader tradetally > backup-$(date +%Y%m%d).sql
```

Restore (DESTRUCTIVE — drops + reloads):
```bash
kubectl -n tradetally exec -i tradetally-db-0 -- psql -U trader tradetally < backup-YYYYMMDD.sql
```

View slow queries (top 10 by total time):
```bash
kubectl -n tradetally exec tradetally-db-0 -- psql -U trader tradetally -c \
  "SELECT round(total_exec_time::numeric, 1) AS total_ms, calls,
          round(mean_exec_time::numeric, 1) AS mean_ms, query
   FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10;"
```

**Apply postgresql.conf changes:**
```bash
kubectl apply -f talos/manifests/tradetally/postgres/postgresql-config.yaml
# ConfigMap reaches the pod's filesystem; Postgres only re-reads on SIGHUP or restart:
kubectl rollout restart statefulset/tradetally-db -n tradetally
```

## Password reset escape hatch (no SMTP in v1)

With `REGISTRATION_MODE=closed` and no SMTP, there's no in-app password reset.
If you lock yourself out, reset via direct DB:

```bash
# Inspect what hash scheme the app uses (check users table)
kubectl -n tradetally exec tradetally-db-0 -- psql -U trader tradetally -c \
  "SELECT email, substring(password_hash, 1, 4) AS scheme_hint FROM users;"
# Most likely bcrypt — use a one-off node container:
kubectl run -i --rm bcrypt-tmp --image=node:20-alpine --restart=Never -- \
  node -e "console.log(require('bcryptjs').hashSync('NEW_PASSWORD', 10))" \
  | tail -1
# Apply:
kubectl -n tradetally exec tradetally-db-0 -- psql -U trader tradetally -c \
  "UPDATE users SET password_hash='<paste hash>' WHERE email='admin@...';"
```

## When things break — TradeTally-specific

**App pod CrashLoopBackOff during first 10 min after install**
First-boot is slow (189 migrations + scheduler inits before `app.listen()`).
`startupProbe` budget is 10 min — wait it out before debugging.
If still failing past 10 min: `kubectl logs deploy/tradetally-app -n tradetally`
and look for SQL errors in the migrate output.

**App pod stuck Pending**
Local-path PVC pins to a single node. If that node is down, the pod stays
Pending. `kubectl describe pvc tradetally-uploads -n tradetally` shows which
node. Bring the node back or restore the PVC data on a new node manually.

**Postgres pod stuck Pending**
Same root cause — local-path PVC on a downed node. `kubectl describe pvc
data-tradetally-db-0 -n tradetally`.

**Schwab OAuth callback fails ("redirect_uri mismatch")**
The `SCHWAB_REDIRECT_URI` in `tradetally-config.yaml` and the URI you
registered with Schwab's developer portal must match character-for-character.
Re-check both.

**Passkey registration silently fails**
Check `WEBAUTHN_RP_ID` in the ConfigMap matches the hostname the browser
sees in the URL bar exactly (no www, no port). If hostname has changed since
existing passkeys were registered: those passkeys are dead — users re-register.

**/uploads PVC full**
```bash
kubectl exec -it deploy/tradetally-app -n tradetally -- du -sh /app/backend/uploads/*
```
Either prune (`rm` old uploads from inside the pod, with a backup), or
resize the PVC (local-path supports online resize: edit PVC `.spec.resources.requests.storage`,
then restart the pod).

**/api/health returns 502 through the Ingress**
Likely the backend isn't bound to port 3000. The image's in-baked nginx
hardcodes `proxy_pass http://localhost:3000` — if the app's `PORT` env
isn't `3000`, nginx 502s. Check the ConfigMap has `PORT: "3000"` (it does
by design). If something removed it, the joi default of 5001 takes over and
nothing works.

## Known gotchas (from spec)

The full list lives in the spec. Quick references for 2am:

1. First-boot ≤10 min OK (gotcha #1)
2. Local-path pins pods to nodes (gotcha #2)
3. `Recreate` strategy = brief downtime on every upgrade (gotcha #3)
4. Schwab redirect URI mismatch = OAuth fails (gotcha #4)
5. `/api-docs` is LAN-reachable (gotcha #5)
6. No backups in v1 — pg_dump manually or snapshot the Proxmox VM (gotcha #6)
7. `/api/health` always 200; `.status` = `DEGRADED` is normal w/ scheduler off (gotcha #7)
8. `WEBAUTHN_RP_ID` is write-once after passkeys registered (gotcha #8)
9. Hostname change = triple-coordinated edit (gotcha #9)
10. No SMTP = no password reset; psql escape hatch above (gotcha #10)
11. After upgrade, verify migration count matches repo (gotcha #11)

## Future work

Tracked in spec § "Future work". Top of mind:
1. Off-cluster pg_dump CronJob (closes the backup gap)
2. Schwab integration once developer-portal app is registered
3. Argo enrollment when florida-apps migrate
