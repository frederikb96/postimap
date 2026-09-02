import { existsSync } from "node:fs";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, Network, Wait } from "testcontainers";
import { type ContainerConfig, setManagedContainers } from "./containers.js";
import { env } from "./env.js";

/**
 * Point testcontainers at the rootless podman socket when nothing else already does.
 * Left alone if DOCKER_HOST is set or a real Docker socket exists (e.g. the CI runner's
 * DinD sidecar) — this only fills the gap on a bare podman-only dev machine.
 */
function wirePodmanSocket(): void {
  if (process.env.DOCKER_HOST || existsSync("/var/run/docker.sock")) {
    return;
  }
  const runtimeDir = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`;
  const podmanSocket = `${runtimeDir}/podman/podman.sock`;
  if (!existsSync(podmanSocket)) {
    throw new Error(
      "No container runtime found: DOCKER_HOST is unset, /var/run/docker.sock is missing, and " +
        `no podman socket at ${podmanSocket}. Enable it with: ` +
        "systemctl --user enable --now podman.socket",
    );
  }
  process.env.DOCKER_HOST = `unix://${podmanSocket}`;
}

export default async function setup() {
  const isCI = process.env.CI === "true" || process.env.CI === "1";

  wirePodmanSocket();
  // Ryuk needs privileges rootless podman does not grant; reuse (below) keeps local
  // iteration fast without it, and CI runner pods are torn down between jobs anyway.
  process.env.TESTCONTAINERS_RYUK_DISABLED = "true";
  // The mail server's self-signed cert; tell the sync engine to accept it in tests
  process.env.POSTIMAP_IMAP_TLS_REJECT_UNAUTHORIZED = "false";

  const network = await new Network().start();

  let pgContainer = new PostgreSqlContainer("postgres:18-alpine")
    .withDatabase(env.PG_DATABASE)
    .withUsername(env.PG_USER)
    .withPassword(env.PG_PASSWORD);
  if (!isCI) pgContainer = pgContainer.withReuse();
  const startedPg = await pgContainer.start();

  // Any username authenticates with MAIL_PASSWORD and gets its mailbox auto-created on
  // first login — there is no admin API to provision accounts, see mailserver-admin.ts.
  // CONDSTORE and QRESYNC are on by default (verified in imap/capabilities.test.ts).
  let mailContainer = new GenericContainer("dovecot/dovecot:2.4.5")
    .withExposedPorts(31143, 31024)
    .withEnvironment({ USER_PASSWORD: env.MAIL_PASSWORD })
    .withNetwork(network)
    .withNetworkAliases("mailserver")
    .withWaitStrategy(Wait.forListeningPorts());
  if (!isCI) mailContainer = mailContainer.withReuse();
  const startedMail = await mailContainer.start();

  // No shell in this image, so an exec-based healthcheck can't probe HTTP readiness.
  // Callers poll the API directly instead (see createToxiproxyClient in chaos-helpers.ts).
  let toxiproxyContainer = new GenericContainer("ghcr.io/shopify/toxiproxy:2.12.0")
    .withExposedPorts(8474, 21001, 23001)
    .withNetwork(network)
    .withWaitStrategy(Wait.forHttp("/version", 8474));
  if (!isCI) toxiproxyContainer = toxiproxyContainer.withReuse();
  const startedToxiproxy = await toxiproxyContainer.start();

  // SMTP sink for outbox tests: a real SMTP server to send to (proving PostIMAP actually
  // dispatched a message) with an HTTP API to assert on what it received. Accepts any
  // SMTP AUTH by default (MP_SMTP_AUTH_ACCEPT_ANY=1, MP_SMTP_AUTH_ALLOW_INSECURE=1) so
  // an account's smtp_user/smtp_password round-trip through a real AUTH exchange.
  let mailpitContainer = new GenericContainer("axllent/mailpit:v1.28.3")
    .withExposedPorts(1025, 8025)
    .withNetwork(network)
    .withWaitStrategy(Wait.forHttp("/readyz", 8025));
  if (!isCI) mailpitContainer = mailpitContainer.withReuse();
  const startedMailpit = await mailpitContainer.start();

  // CalDAV/CardDAV server for DAV tests. Ready in ~3s, no provisioning -- any Basic auth
  // credentials are accepted and the principal is auto-created on first request. "/"
  // redirects to "/.web", which is what makes 302 the ready signal rather than 200.
  let radicaleContainer = new GenericContainer("tomsquest/docker-radicale:3.7.6.0")
    .withExposedPorts(5232)
    .withNetwork(network)
    .withNetworkAliases("radicale")
    .withWaitStrategy(Wait.forHttp("/", 5232).forStatusCodeMatching((code) => code === 302));
  if (!isCI) radicaleContainer = radicaleContainer.withReuse();
  const startedRadicale = await radicaleContainer.start();

  setManagedContainers({
    pg: startedPg,
    mail: startedMail,
    toxiproxy: startedToxiproxy,
    mailpit: startedMailpit,
    radicale: startedRadicale,
  });

  const config: ContainerConfig = {
    pgHost: startedPg.getHost(),
    pgPort: startedPg.getMappedPort(5432),
    imapHost: startedMail.getHost(),
    imapPort: startedMail.getMappedPort(31143),
    lmtpHost: startedMail.getHost(),
    lmtpPort: startedMail.getMappedPort(31024),
    mailpitHost: startedMailpit.getHost(),
    mailpitSmtpPort: startedMailpit.getMappedPort(1025),
    mailpitHttpPort: startedMailpit.getMappedPort(8025),
    radicaleHost: startedRadicale.getHost(),
    radicalePort: startedRadicale.getMappedPort(5232),
  };

  process.env.POSTIMAP_TEST_PG_HOST = config.pgHost;
  process.env.POSTIMAP_TEST_PG_PORT = String(config.pgPort);
  process.env.POSTIMAP_TEST_IMAP_HOST = config.imapHost;
  process.env.POSTIMAP_TEST_IMAP_PORT = String(config.imapPort);
  process.env.POSTIMAP_TEST_LMTP_HOST = config.lmtpHost;
  process.env.POSTIMAP_TEST_LMTP_PORT = String(config.lmtpPort);
  process.env.POSTIMAP_TEST_MAILPIT_HOST = config.mailpitHost;
  process.env.POSTIMAP_TEST_MAILPIT_SMTP_PORT = String(config.mailpitSmtpPort);
  process.env.POSTIMAP_TEST_MAILPIT_HTTP_PORT = String(config.mailpitHttpPort);
  process.env.POSTIMAP_TEST_RADICALE_HOST = config.radicaleHost;
  process.env.POSTIMAP_TEST_RADICALE_PORT = String(config.radicalePort);
  process.env.POSTIMAP_TEST_TOXIPROXY_HOST = startedToxiproxy.getHost();
  process.env.POSTIMAP_TEST_TOXIPROXY_PORT = String(startedToxiproxy.getMappedPort(8474));
  process.env.POSTIMAP_TEST_TOXIPROXY_IMAP_PORT = String(startedToxiproxy.getMappedPort(21001));
  process.env.POSTIMAP_TEST_TOXIPROXY_SLOW_PORT = String(startedToxiproxy.getMappedPort(23001));
  // Toxiproxy upstream reaches the mail server via the shared container network
  process.env.POSTIMAP_TEST_TOXIPROXY_IMAP_UPSTREAM = "mailserver:31143";

  // Reused containers are left running for the next local run. In CI (no reuse), Ryuk is
  // disabled too, so tear them down explicitly instead of leaking them past the job.
  if (isCI) {
    return async () => {
      await startedRadicale.stop();
      await startedToxiproxy.stop();
      await startedMailpit.stop();
      await startedMail.stop();
      await startedPg.stop();
      await network.stop();
    };
  }
}
