import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { PpssppClient } from "../ppsspp.js";
import type { ToolHandler, ToolModule } from "./shared.js";
import { coreTools } from "./core.js";
import { memoryTools } from "./memory.js";
import { breakpointTools } from "./breakpoints.js";
import { disasmTools } from "./disasm.js";
import { liveDebugTools } from "./live_debug.js";
import { textureTools } from "./texture.js";
import { scannerTools } from "./scanner.js";
import { symbolTools } from "./symbols.js";
import { createDecompilerTools } from "./decompiler.js";
import { isGhidraAvailable } from "../decompiler.js";

const ALWAYS_ON_MODULES: ToolModule[] = [
  coreTools, memoryTools, breakpointTools, disasmTools, liveDebugTools, textureTools, scannerTools, symbolTools,
];

export async function registerTools(server: Server, pp: PpssppClient): Promise<void> {
  const modules = [...ALWAYS_ON_MODULES];

  // Opt-in: only register ppsspp_decompile* if Ghidra/pyghidra are actually
  // usable, so tools/list never advertises something that can't work.
  if (await isGhidraAvailable()) {
    modules.push(createDecompilerTools());
  } else {
    process.stderr.write(
      "[mcp-ppsspp] Ghidra/pyghidra not available (GHIDRA_INSTALL_DIR unset, or `python3 -c \"import pyghidra\"` failed) " +
      "— ppsspp_decompile* tools disabled. See README for setup.\n",
    );
  }

  const tools: Tool[] = modules.flatMap((m) => m.tools);
  const handlers: Record<string, ToolHandler> = Object.assign({}, ...modules.map((m) => m.handlers));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const handler = handlers[name];
    if (!handler) throw new Error(`Unknown tool: ${name}`);
    return handler(pp, args as Record<string, unknown>);
  });
}
