/**
 * VNAAS Grinder Server — Entry Point
 *
 * ContextVM MCP server that exposes vanity NPUB offset grinding
 * as an MCP tool over Nostr relays.
 */
import { loadConfig } from './config.js';
import { createServer } from './server/contextvm-server.js';

async function main() {
  const config = loadConfig();
  const server = await createServer(config);
  await server.start();
  console.log(`[VNAAS] Server running on relays: ${config.relays.join(', ')}`);
  console.log(`[VNAAS] Server npub: ${config.serverNpub}`);
  console.log('[VNAAS] MCP tool: grind_npub');
  console.log('[VNAAS] Press Ctrl+C to stop');
}

main().catch((err) => {
  console.error('[VNAAS] Fatal error:', err);
  process.exit(1);
});