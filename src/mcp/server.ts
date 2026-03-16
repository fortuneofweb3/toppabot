import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Request, Response } from 'express';
import { registerMcpTools } from './tools';

/**
 * MCP Server — Streamable HTTP transport for Toppa's 12 tools.
 *
 * Creates a fresh McpServer + transport per request to avoid state leakage
 * between concurrent requests. Tool registration is lightweight (no I/O),
 * so the overhead is minimal compared to the Reloadly API calls themselves.
 */

/**
 * Handle an incoming MCP request from Express.
 * Each request gets its own McpServer + transport to prevent state leakage.
 */
export async function handleMcpRequest(req: Request, res: Response) {
  try {
    const server = new McpServer({
      name: 'toppa',
      version: '2.0.0',
    });

    registerMcpTools(server);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
    });

    res.on('close', () => {
      transport.close().catch(() => {});
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error: any) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
      });
    }
  }
}
