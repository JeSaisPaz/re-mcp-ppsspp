import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  ADDRESS_PARAM_DESC, REPLACEMENTS_PARAM_DESC, MEM_WIDTH_INFO,
  makeReadTool, makeWriteTool, ok, fmtHex, addrHex,
  type MemWidth, type ToolModule,
} from "./shared.js";

const tools: Tool[] = [
  makeReadTool(8),
  makeReadTool(16),
  makeReadTool(32),
  {
    name: "ppsspp_read_range",
    description:
      "PURPOSE: Read a contiguous range of bytes from PSP memory and return as a hex dump. " +
      "USAGE: Use whenever you need more than ~4 bytes — one round-trip vs N typed reads. PPSSPP returns the data base64-encoded over the wire; this tool decodes and formats as space-separated hex bytes. No hard size limit from the WebSocket but stay reasonable (≤16 KiB per call) for response sizes. " +
      "BEHAVIOR: No side effects — pure read. Reads `size` consecutive bytes starting at `address`. Returns an error if any byte in the range is outside the valid PSP memory map. " +
      "RETURNS: 'ADDR_HEX [N bytes]:' header + space-separated 2-digit uppercase hex bytes.",
    inputSchema: {
      type: "object",
      required: ["address", "size"],
      properties: {
        address: { type: "integer", minimum: 0, description: ADDRESS_PARAM_DESC },
        size:    { type: "integer", minimum: 1, maximum: 65536, description: "Number of bytes to read (1-65536). Larger reads work but produce big responses." },
        replacements: { type: "boolean", description: REPLACEMENTS_PARAM_DESC },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ppsspp_read_string",
    description:
      "PURPOSE: Read a null-terminated UTF-8 string from PSP memory at the given address. " +
      "USAGE: Use for in-game text, character names, dialogue, file names — anywhere the PSP stores a C-style null-terminated string. Stops at the first 0x00 byte. " +
      "BEHAVIOR: No side effects — pure read. Reads bytes until null terminator, decodes as UTF-8. Returns an error if the address is outside valid memory, or if the string runs past valid memory before hitting a null. " +
      "RETURNS: Single line 'ADDR_HEX: \"STRING\"'.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: {
        address: { type: "integer", minimum: 0, description: ADDRESS_PARAM_DESC },
      },
      additionalProperties: false,
    },
  },
  makeWriteTool(8),
  makeWriteTool(16),
  makeWriteTool(32),
  {
    name: "ppsspp_write_range",
    description:
      "PURPOSE: Write a contiguous byte sequence to PSP memory starting at the given address. " +
      "USAGE: Use for installing cheat tables, patching code blocks, or seeding regions. Bytes are sent base64-encoded over the wire. " +
      "BEHAVIOR: DESTRUCTIVE: overwrites N bytes with no undo. Direct memory write. Returns an error if address+N exceeds valid memory or any byte value is outside 0-255. " +
      "RETURNS: Single line 'Wrote N bytes → ADDR_HEX'.",
    inputSchema: {
      type: "object",
      required: ["address", "bytes"],
      properties: {
        address: { type: "integer", minimum: 0, description: ADDRESS_PARAM_DESC },
        bytes: {
          type: "array",
          items: { type: "integer", minimum: 0, maximum: 255 },
          minItems: 1,
          maxItems: 65536,
          description: "Byte values (each 0-255), written sequentially from `address`.",
        },
      },
      additionalProperties: false,
    },
  },
];

export const memoryTools: ToolModule = {
  tools,
  handlers: {
    ppsspp_read8: (pp, p) => readHandler(8, pp, p),
    ppsspp_read16: (pp, p) => readHandler(16, pp, p),
    ppsspp_read32: (pp, p) => readHandler(32, pp, p),
    ppsspp_write8: (pp, p) => writeHandler(8, pp, p),
    ppsspp_write16: (pp, p) => writeHandler(16, pp, p),
    ppsspp_write32: (pp, p) => writeHandler(32, pp, p),

    ppsspp_read_range: async (pp, p) => {
      const address = p.address as number;
      const r = await pp.call<{ base64: string }>("memory.read", { address, size: p.size, replacements: p.replacements });
      const bytes = Buffer.from(r.base64 ?? "", "base64");
      const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
      return ok(`${addrHex(address)} [${bytes.length} bytes]:\n${hex}`);
    },
    ppsspp_read_string: async (pp, p) => {
      const address = p.address as number;
      const r = await pp.call<{ value: string }>("memory.readString", { address, type: "utf-8" });
      return ok(`${addrHex(address)}: ${JSON.stringify(r.value ?? "")}`);
    },
    ppsspp_write_range: async (pp, p) => {
      const address = p.address as number;
      const bytes = Buffer.from(p.bytes as number[]);
      const base64 = bytes.toString("base64");
      await pp.call("memory.write", { address, base64 });
      return ok(`Wrote ${bytes.length} bytes → ${addrHex(address)}`);
    },
  },
};

async function readHandler(width: MemWidth, pp: Parameters<typeof memoryTools.handlers.ppsspp_read8>[0], p: Record<string, unknown>) {
  const address = p.address as number;
  const r = await pp.call<{ value: number }>(MEM_WIDTH_INFO[width].readEvent, { address, replacements: p.replacements });
  return ok(`${addrHex(address)}: ${fmtHex(r.value)}`);
}

async function writeHandler(width: MemWidth, pp: Parameters<typeof memoryTools.handlers.ppsspp_write8>[0], p: Record<string, unknown>) {
  const address = p.address as number;
  await pp.call(MEM_WIDTH_INFO[width].writeEvent, { address, value: p.value });
  return ok(`Wrote ${fmtHex(p.value)} → ${addrHex(address)}`);
}
