import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { PpssppClient } from "../ppsspp.js";
import type { ToolHandler } from "./shared.js";
import { coreTools } from "./core.js";
import { memoryTools } from "./memory.js";
import { breakpointTools } from "./breakpoints.js";
import { disasmTools } from "./disasm.js";

const MODULES = [coreTools, memoryTools, breakpointTools, disasmTools];

export function registerTools(server: Server, pp: PpssppClient): void {
  const tools: Tool[] = MODULES.flatMap((m) => m.tools);
  const handlers: Record<string, ToolHandler> = Object.assign({}, ...MODULES.map((m) => m.handlers));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const handler = handlers[name];
    if (!handler) throw new Error(`Unknown tool: ${name}`);
    return handler(pp, args as Record<string, unknown>);
  });
}
