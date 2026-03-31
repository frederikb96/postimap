import { env } from "./env.js";
import { waitFor } from "./wait-for.js";

/**
 * HTTP REST API client for the Stalwart v0.11+ test mail server admin interface.
 * Uses /api/principal endpoint for all user/domain management.
 */
export class StalwartAdmin {
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? env.STALWART_ADMIN_URL;
    this.authHeader = `Basic ${btoa(`${env.STALWART_ADMIN_USER}:${env.STALWART_ADMIN_PASSWORD}`)}`;
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      "Content-Type": "application/json",
    };

    const resp = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    return resp;
  }

  /**
   * Create a domain in Stalwart via principal API.
   */
  async createDomain(domain: string): Promise<void> {
    const resp = await this.request("POST", "/api/principal", {
      type: "domain",
      name: domain,
    });
    if (!resp.ok) {
      const text = await resp.text();
      // Ignore "already exists" errors
      if (!text.includes("alreadyExists")) {
        throw new Error(`createDomain(${domain}) failed: ${resp.status} ${text}`);
      }
    }
  }

  /**
   * Create a mail account via principal API.
   */
  async createAccount(email: string, password: string): Promise<void> {
    const domain = email.split("@")[1];
    await this.createDomain(domain);

    const resp = await this.request("POST", "/api/principal", {
      type: "individual",
      name: email,
      secrets: [password],
      emails: [email],
      roles: ["user"],
    });

    if (!resp.ok) {
      const text = await resp.text();
      if (!text.includes("alreadyExists")) {
        throw new Error(`createAccount(${email}) failed: ${resp.status} ${text}`);
      }
    }
  }

  /**
   * Delete a mail account via principal API.
   */
  async deleteAccount(email: string): Promise<void> {
    const resp = await this.request("DELETE", `/api/principal/${encodeURIComponent(email)}`);
    if (!resp.ok && resp.status !== 404) {
      throw new Error(`deleteAccount(${email}) failed: ${resp.status} ${await resp.text()}`);
    }
  }

  /**
   * Poll the admin API until it responds, or throw on timeout.
   */
  async waitReady(timeoutMs = 30_000): Promise<void> {
    await waitFor(
      async () => {
        try {
          const resp = await fetch(`${this.baseUrl}/`, {
            signal: AbortSignal.timeout(2_000),
          });
          return resp.ok;
        } catch {
          return false;
        }
      },
      { timeout: timeoutMs, interval: 500 },
    );
  }
}

/**
 * Shared singleton for test suites.
 */
export const stalwartAdmin = new StalwartAdmin();
