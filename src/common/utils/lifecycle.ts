/**
 * Process lifecycle flag, shared by the shutdown handler and `/readyz`.
 *
 * During a rolling deploy the load balancer must stop sending new requests
 * *before* the process stops accepting them, so readiness has to fail as soon as
 * SIGTERM arrives even though the server is still draining in-flight work.
 */
let shuttingDown = false;

export function beginShutdown(): void {
  shuttingDown = true;
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

/** Test-only: reset between cases. */
export function resetLifecycle(): void {
  shuttingDown = false;
}
