/**
 * ContextVM MCP Server setup.
 *
 * Creates an MCP server that exposes the `grind_npub` tool and connects it
 * to a Nostr transport layer using the @contextvm/sdk.
 *
 * The server listens for NIP-04/NIP-59 encrypted MCP JSON-RPC requests
 * on configured Nostr relays and responds to clients over the same channel.
 */

import { McpServer } from "@contextvm/mcp-sdk/server/mcp.js";
import {
  NostrServerTransport,
  ApplesauceRelayPool,
  PrivateKeySigner,
  EncryptionMode,
  type ServerInfo,
} from "@contextvm/sdk";
import type { ServerConfig } from "../types.js";
import { grindNpubSchema, handleGrindNpub } from "./tools.js";

/**
 * Create and configure the ContextVM MCP server with the grind_npub tool.
 *
 * @param config - Server configuration (relays, keys, etc.)
 * @returns An object with the MCP server, Nostr transport, and a start() function.
 */
export function createServer(config: ServerConfig): {
  mcpServer: McpServer;
  transport: NostrServerTransport;
  start: () => Promise<void>;
  stop: () => Promise<void>;
} {
  // --- Create the Nostr signer from the server's private key ---
  const signer = new PrivateKeySigner(config.serverPrivateKey);

  // --- Create the relay pool ---
  const relayHandler = new ApplesauceRelayPool(config.relays);

  // --- Server info for announcement ---
  const serverInfo: ServerInfo = {
    name: "vanaas-grinder",
    about:
      "Vanity NPUB offset grinding server. Grinds P + d·G to find vanity " +
      "npub patterns without seeing your secret key.",
    website: "https://github.com/c03rad0r/asymmetric-vanity-npubs",
  };

  // --- Create the Nostr server transport ---
  const transport = new NostrServerTransport({
    signer,
    relayHandler,
    encryptionMode: EncryptionMode.REQUIRED,
    serverInfo,
    isAnnouncedServer: true,
    logLevel: "info",
  });

  // --- Create the MCP server ---
  const mcpServer = new McpServer(
    { name: "vanaas-grinder", version: "0.1.0" },
    {
      capabilities: {
        tools: {},
      },
      instructions:
        "VNAAS Grinder: Call the grind_npub tool with your npub and vanity " +
        "pattern to get an offset integer. The server never sees your secret key.",
    }
  );

  // --- Register the grind_npub tool ---
  mcpServer.registerTool(
    "grind_npub",
    {
      title: "Grind Vanity NPUB",
      description:
        "Grind a vanity NPUB offset for a public key using offset grinding " +
        "(P + d·G). The server never sees your secret key. Returns an offset " +
        "integer you add to your nsec. Dispatches to GPU, CPU (rana), or " +
        "instructs client to grind in-browser.",
      inputSchema: grindNpubSchema,
    },
    async (args) => {
      return handleGrindNpub(args);
    }
  );

  // --- Start/stop functions ---
  async function start(): Promise<void> {
    // Connect relay pool first
    await relayHandler.connect();
    // Connect MCP server to the Nostr transport
    await mcpServer.connect(transport);
  }

  async function stop(): Promise<void> {
    await mcpServer.close();
    await relayHandler.disconnect();
  }

  return { mcpServer, transport, start, stop };
}