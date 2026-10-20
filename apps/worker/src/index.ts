import { loadRootEnv } from "./env";

loadRootEnv();

const { providerName } = await import("@cf/ai");
const { startWorkers, shutdownConnections } = await import("./workers");

const running = await startWorkers();
console.info(`CatalogForge worker started (pid ${process.pid}, AI: ${providerName()})`);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.info(`${signal} received: finishing active jobs, then exiting`);
  // Active jobs finish or are released; anything unfinished is picked up as stalled or by the reconciler.
  const force = setTimeout(() => process.exit(1), 30_000);
  await running.stop();
  await shutdownConnections();
  clearTimeout(force);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
