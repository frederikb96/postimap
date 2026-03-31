import path from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, Wait } from "testcontainers";
import {
  type ContainerConfig,
  checkConnection,
  composeConfig,
  setManagedContainers,
} from "./containers.js";
import { env } from "./env.js";

export default async function setup(context: { provide: (key: string, value: unknown) => void }) {
  const composeRunning = await checkConnection(env.PG_HOST, env.PG_PORT);

  if (composeRunning) {
    const config = composeConfig();
    context.provide("containerConfig", config);
    return;
  }

  // Testcontainers mode (CI or no compose running)
  const pgContainer = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase(env.PG_DATABASE)
    .withUsername(env.PG_USER)
    .withPassword(env.PG_PASSWORD)
    .start();

  const stalwartContainer = await new GenericContainer("stalwartlabs/mail-server:v0.11.4")
    .withExposedPorts(1143, 2525, 8080)
    .withCopyFilesToContainer([
      {
        source: path.resolve(import.meta.dirname, "../fixtures/stalwart-test.toml"),
        target: "/opt/stalwart-mail/etc/config.toml",
      },
    ])
    .withEnvironment({ STALWART_ADMIN_PASSWORD: env.STALWART_ADMIN_PASSWORD })
    .withWaitStrategy(Wait.forListeningPorts())
    .start();

  const toxiproxyContainer = await new GenericContainer("ghcr.io/shopify/toxiproxy:2.9.0")
    .withExposedPorts(8474, 21001, 23001)
    .withWaitStrategy(Wait.forHttp("/version", 8474))
    .start();

  setManagedContainers({ pg: pgContainer, stalwart: stalwartContainer });

  const config: ContainerConfig = {
    mode: "testcontainers",
    pgHost: pgContainer.getHost(),
    pgPort: pgContainer.getMappedPort(5432),
    imapHost: stalwartContainer.getHost(),
    imapPort: stalwartContainer.getMappedPort(1143),
    smtpHost: stalwartContainer.getHost(),
    smtpPort: stalwartContainer.getMappedPort(2525),
    stalwartAdminUrl: `http://${stalwartContainer.getHost()}:${stalwartContainer.getMappedPort(8080)}`,
  };

  // Override env vars so helpers use testcontainer ports
  process.env.POSTIMAP_TEST_PG_HOST = config.pgHost;
  process.env.POSTIMAP_TEST_PG_PORT = String(config.pgPort);
  process.env.POSTIMAP_TEST_IMAP_HOST = config.imapHost;
  process.env.POSTIMAP_TEST_IMAP_PORT = String(config.imapPort);
  process.env.POSTIMAP_TEST_SMTP_HOST = config.smtpHost;
  process.env.POSTIMAP_TEST_SMTP_PORT = String(config.smtpPort);
  process.env.POSTIMAP_TEST_STALWART_ADMIN_URL = config.stalwartAdminUrl;
  process.env.POSTIMAP_TEST_TOXIPROXY_HOST = toxiproxyContainer.getHost();
  process.env.POSTIMAP_TEST_TOXIPROXY_PORT = String(toxiproxyContainer.getMappedPort(8474));
  // Toxiproxy upstream must reach Stalwart from inside the toxiproxy container via host network
  process.env.POSTIMAP_TEST_TOXIPROXY_IMAP_UPSTREAM = `host.testcontainers.internal:${stalwartContainer.getMappedPort(1143)}`;

  context.provide("containerConfig", config);

  return async () => {
    await toxiproxyContainer.stop();
    await pgContainer.stop();
    await stalwartContainer.stop();
  };
}
