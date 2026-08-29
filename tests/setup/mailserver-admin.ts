import { getManagedContainers } from "./containers.js";

/**
 * The test mail server has no account-provisioning API: any username authenticates with
 * the shared MAIL_PASSWORD (see env.ts) and gets its mailbox created on first login.
 * "Creating" an account is therefore just picking a unique email address; this class
 * exists so call sites keep the same create/delete shape as before and get their test
 * mail cleaned up afterwards.
 */
export class MailServerAdmin {
  async createAccount(_email: string, _password?: string): Promise<void> {
    // no-op by design, see class doc
  }

  /**
   * Best-effort mail wipe so repeated local runs against a reused container don't
   * accumulate test mailboxes forever. Failures are swallowed: cleanup is a courtesy,
   * not a correctness requirement (each test uses a unique email address).
   */
  async deleteAccount(email: string): Promise<void> {
    const mail = getManagedContainers().mail;
    if (!mail) return;
    try {
      await mail.exec(["doveadm", "expunge", "-u", email, "mailbox", "*", "all"]);
    } catch {
      // best-effort
    }
  }
}
