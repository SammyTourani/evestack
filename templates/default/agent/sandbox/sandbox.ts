import { defineSandbox } from "eve/sandbox";
import { docker } from "eve/sandbox/docker";

/**
 * The agent's isolated bash environment.
 *
 * Docker is the default because it runs anywhere and most people already have
 * it. eve keeps one long-lived container per durable session and persists
 * /workspace across turns, with no idle timeout — so this is genuinely free to
 * run 24/7 on your own machine.
 *
 * Swaps, one line each:
 *   microsandbox() — real VM isolation, domain-level network policy, and
 *                    credential brokering. macOS/Apple Silicon or Linux+KVM.
 *   justbash()     — no daemon at all, but simulated bash with no real binaries.
 *
 * Note the Docker backend honors only "allow-all" and "deny-all" for network
 * policy; domain allow-lists need microsandbox.
 */
export default defineSandbox({
  backend: docker(),
});
