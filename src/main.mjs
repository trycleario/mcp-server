#!/usr/bin/env node
/**
 * main.mjs — the command: `npx -y @trycleario/mcp-server@latest`. The TryClear MCP server over stdio.
 * Its settings come from the environment (server.mjs). stdout carries the protocol and nothing else.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { makeServer } from './server.mjs';

await makeServer().connect(new StdioServerTransport());
