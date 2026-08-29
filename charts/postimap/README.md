# PostIMAP Helm Chart

Deploys [PostIMAP](https://github.com/frederikb96/postimap) -- a bidirectional IMAP-to-PostgreSQL sync microservice -- onto Kubernetes.

## Rendering from the registry

`helm template` and `helm pull` write `Pulled:` and `Digest:` lines to **stdout** when the chart
reference is an OCI URL, so piping straight into `kubectl apply -f -` fails with
`apiVersion not set, kind not set`. Strip the preamble, or render from a local copy:

```bash
helm pull oci://ghcr.io/frederikb96/charts/postimap --version <version> -d ./charts
helm template postimap ./charts/postimap-<version>.tgz -f values.yaml | kubectl apply -f -
```

`helm pull` also requires the `-d` directory to exist already.

## Before you install

PostIMAP needs an existing PostgreSQL database and at least one IMAP account row inserted after it's running. This chart does not create either for you:

- **PostgreSQL is not a chart dependency.** Point `config.database.host` (and friends) at a database you already run. See [`examples/cnpg-cluster.yaml`](examples/cnpg-cluster.yaml) for a worked [CloudNativePG](https://cloudnative-pg.io/) setup, including the two-role split (PostIMAP's own schema-owning role vs. your application's narrower role).
- **No account, no sync.** PostIMAP does nothing until a row exists in its `accounts` table -- it discovers new accounts via a PostgreSQL trigger (`account_changes` NOTIFY) and starts syncing automatically, without a restart. See [Adding an account](#adding-an-account) below.
- **Migrations run automatically**, inside the single running pod, before it starts serving health checks. There's no separate migration Job or Helm hook to run.

## Why exactly one replica

PostIMAP holds all per-account sync state in memory in a single process: IMAP IDLE connections, the orchestrator's account state machine, in-flight sync_queue processing. There is no leader election or per-account leasing between replicas. Two pods syncing the same account would race each other and corrupt sync state.

`replicaCount` is pinned to `1` by `values.schema.json` -- `--set replicaCount=2` fails validation rather than deploying something broken. The Deployment also uses `strategy: Recreate` (not configurable) instead of a rolling update, because briefly running an old and a new pod together during a rollout has the exact same problem.

If you need to migrate PostIMAP to a different node or resize it, expect a brief sync gap while the old pod terminates and the new one starts -- that's inherent to `Recreate`, not a chart bug.

## Install

```bash
helm install postimap oci://ghcr.io/frederikb96/charts/postimap \
  --namespace mail --create-namespace \
  --set config.database.host=<your-postgres-host> \
  --set secret.create=true \
  --set secret.dbPassword=<password>
```

For anything beyond a quick test, write a values file instead -- see [`examples/values-production.yaml`](examples/values-production.yaml) for a realistic one (external CNPG database, pre-existing Secret, GHCR pull secret, `extraEnv`, `NetworkPolicy`).

### Configuration model

The image bundles `config/config.yaml` with defaults for everything. This chart's `config:` value is a **sparse override** -- a ConfigMap rendered from it and mounted at `configOverridePath`, deep-merged onto the image's defaults at startup. Its structure mirrors `config/config.yaml` in the [repository](https://github.com/frederikb96/postimap/blob/main/config/config.yaml) exactly, so only set the keys you want to change:

```yaml
config:
  database:
    host: my-postgres-host
  sync:
    interval_seconds: 30
```

This is deliberately freeform. When the app gains new configuration sections in the future (for example around storage or retention), set them the same way -- no chart changes needed to use them.

`config.database.password` is left unset on purpose: the image's default config already resolves it from the `DB_PASSWORD` environment variable via a `${DB_PASSWORD}` placeholder, which this chart wires from a Secret (see below) rather than duplicating the value in the ConfigMap.

Anything the config loader doesn't cover directly -- or that you'd rather set as a `POSTIMAP_SECTION_KEY` environment variable override instead of YAML -- goes through `extraEnv`.

### Secrets

PostIMAP needs `DB_PASSWORD` and, optionally, `ENCRYPTION_KEY` (a 64-hex-char AES-256-GCM key that encrypts stored IMAP/SMTP account credentials at rest; omitted, they're stored as plaintext).

- `secret.create: true` with `secret.dbPassword` / `secret.encryptionKey` set -- the chart creates the Secret. Convenient for testing; the values end up in Helm release history and (if you commit the values file) in git, so avoid this for anything real.
- `existingSecret: <name>` -- reference a Secret you manage yourself (sealed-secrets, external-secrets, manually `kubectl create secret`, ...), with key names configurable via `existingSecretKeys`. Takes precedence over `secret.create`.

Neither is optional: leave both unset and the pod won't start (the referenced Secret doesn't exist).

### Readiness probe caveat

`/readyz` returns `503` whenever the pod has zero actively-syncing accounts -- which is exactly the state of a fresh install before you've inserted any account row. That's expected, not broken, but it does mean a brand new release sits "not ready" (by whatever cares about Pod readiness -- nothing routes traffic through it besides the health Service itself) until the first account reaches the `active` state.

`readinessProbe.enabled: true` by default, pointed at `/readyz`. If that transient state is a problem for your tooling (e.g. `helm install --wait`), either set `readinessProbe.enabled: false` or point `readinessProbe.path` at `/healthz` instead, which reports `ok` regardless of account count.

### Database connection is not encrypted in transit

PostIMAP connects to PostgreSQL with the [`postgres`](https://github.com/porsager/postgres) driver's defaults -- there's currently no `sslmode`/TLS configuration surface. Treat the PostIMAP-to-PostgreSQL link as trusted-network-only (a `NetworkPolicy` restricting egress to your database, as in the production example, is the practical mitigation inside a cluster), not as a link you can pin with a CA certificate.

### Adding an account

Insert a row into `accounts` from any client connected to the same database -- your application, `psql`, a migration script:

```sql
INSERT INTO accounts (name, imap_host, imap_port, imap_user, imap_password)
VALUES ('inbox', 'imap.example.com', 993, 'user@example.com', 'the-password'::bytea);
```

`imap_password` is `bytea`. If you've configured `ENCRYPTION_KEY`, **encrypt the password yourself before inserting it** -- PostIMAP only decrypts on read, it never encrypts on write, so a plaintext insert stays plaintext in the column until you overwrite it. The scheme is AES-256-GCM with a 12-byte IV and 16-byte auth tag, laid out as `IV || ciphertext || tag`, matching the same key you set as `ENCRYPTION_KEY`.

### Consuming application alongside PostIMAP

The natural layout is: same namespace, same PostgreSQL instance, PostIMAP's own database, and your application connecting with its **own** database role -- narrower than PostIMAP's (which needs schema-owner-equivalent privileges to run migrations). See the `postimap_app` role and its `GRANT`s in [`examples/cnpg-cluster.yaml`](examples/cnpg-cluster.yaml).

Your application talks to PostIMAP purely through that shared database:

- Read replicated mail from `messages`, `folders`, `attachments`.
- Write `UPDATE`s to `messages.is_seen` / `is_flagged` / `is_answered` / `is_draft` / `is_deleted` / `keywords` / `folder_id` / `deleted_at` to change flags, move, or delete a message on the IMAP side -- PostIMAP's own triggers pick these up and enqueue the outbound sync, no NOTIFY needed from your side.
- `INSERT` into `accounts` to add a mailbox; PostIMAP starts syncing it automatically.
- Optionally, `pg_notify('postimap_commands', '{"action": "sync", "account_id": "<uuid>"}')` to force an immediate resync of one account instead of waiting for the next poll interval.

PostIMAP does not emit a NOTIFY when new mail arrives -- if your application wants to react to new messages in real time rather than polling, add your own trigger on `messages` for that; PostIMAP's own triggers and channels are for its outbound sync path, not for downstream consumers.

## Values

| Key | Default | Description |
|---|---|---|
| `replicaCount` | `1` | Pinned by `values.schema.json`. See [Why exactly one replica](#why-exactly-one-replica). |
| `image.repository` | `ghcr.io/frederikb96/postimap` | Container image. |
| `image.pullPolicy` | `IfNotPresent` | |
| `image.tag` | `""` | Defaults to the chart's `appVersion`. |
| `imagePullSecrets` | `[]` | For a private GHCR repository/tag. |
| `nameOverride` / `fullnameOverride` | `""` | Standard chart name overrides. |
| `serviceAccount.create` | `true` | |
| `serviceAccount.automount` | `false` | PostIMAP never calls the Kubernetes API. |
| `serviceAccount.annotations` / `.name` | `{}` / `""` | |
| `podAnnotations` / `podLabels` | `{}` | |
| `podSecurityContext` | non-root, `fsGroup: 1000`, `seccompProfile: RuntimeDefault` | Matches the image's `USER node` (uid/gid 1000). |
| `securityContext` | read-only root filesystem, all capabilities dropped, no privilege escalation | The app writes nothing to disk at runtime; a `tmp` `emptyDir` is mounted at `/tmp` as a safety margin. |
| `service.type` | `ClusterIP` | |
| `service.port` | `8090` | Health port. Must match `config.health.port` if you override the latter -- see the comment in `values.yaml`. |
| `resources` | `100m`/`128Mi` requests, `512Mi` memory limit, no CPU limit | No default CPU limit, to avoid throttling IMAP IDLE/sync loops under load. |
| `livenessProbe` | `GET /healthz` | |
| `readinessProbe.enabled` | `true` | See [Readiness probe caveat](#readiness-probe-caveat). |
| `readinessProbe.path` | `/readyz` | |
| `nodeSelector` / `tolerations` / `affinity` | `{}` / `[]` / `{}` | |
| `extraVolumes` / `extraVolumeMounts` | `[]` | |
| `extraEnv` / `extraEnvFrom` | `[]` | For `POSTIMAP_SECTION_KEY` overrides or anything else the app reads from the environment. |
| `podDisruptionBudget.enabled` | `false` | Meaningless at `replicaCount: 1` beyond signalling voluntary-eviction intent; harmless to enable. |
| `podDisruptionBudget.minAvailable` / `.maxUnavailable` | `null` / `1` | |
| `networkPolicy.enabled` | `false` | |
| `networkPolicy.allowDNS` | `true` | |
| `networkPolicy.egress` | `[]` | **Required if you enable this** -- an empty list under an enabled policy means deny-all, not allow-all. See the comment in `values.yaml`. |
| `config` | `{database: {host: "", port: 5432, name: postimap, user: postimap}}` | Sparse override merged onto the image's `config/config.yaml`. See [Configuration model](#configuration-model). |
| `configOverridePath` | `/app/config-custom/config.override.yaml` | Mount path for the rendered override; matches the image's working directory. |
| `secret.create` | `false` | See [Secrets](#secrets). |
| `secret.dbPassword` / `secret.encryptionKey` | `""` | |
| `existingSecret` | `""` | Takes precedence over `secret.create`. |
| `existingSecretKeys.dbPassword` / `.encryptionKey` | `DB_PASSWORD` / `ENCRYPTION_KEY` | Key names to read from `existingSecret`. |

## Development

```bash
helm lint charts/postimap
helm template postimap charts/postimap -f charts/postimap/examples/values-production.yaml
```
