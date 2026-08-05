// Texture/VRAM inspection — wraps PPSSPP's own (correct) texture decoder so
// it can serve as a reference when diagnosing a separate texture-decoding
// implementation (e.g. a model viewer getting swizzling/CLUT/pixel-format
// handling wrong). PPSSPP only exposes "the currently bound texture" — there
// is no API to enumerate all cached textures — so cataloging several means
// pausing/stepping to each relevant draw call and dumping one at a time.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ok, withStepping, callGpuBufferEvent, extractBase64Png, type ToolModule } from "./shared.js";

const tools: Tool[] = [
  {
    name: "ppsspp_texture_dump",
    description:
      "PURPOSE: Capture the currently-bound GPU texture, decoded by PPSSPP's own (reference-correct) texture pipeline. " +
      "USAGE: The ground-truth reference for diagnosing a separate texture-decoding implementation — dump a texture here and compare against what your own decoder produces for the same VRAM data to isolate exactly where it diverges (wrong swizzle/unswizzle, wrong CLUT indexing, wrong pixel format assumption). There's no PPSSPP API to enumerate all cached textures — pause/breakpoint at the draw call using the texture you want first (this only returns the one currently bound). `mode:'visual'` (default) returns a viewable PNG; `mode:'raw'` returns the undecoded native pixel bytes plus PPSSPP's own format descriptor (e.g. 'A1B5G5R5_UNORM_PACK16') for byte-exact comparison. For paletted/indexed formats, also call ppsspp_texture_clut_dump for the active palette. For the raw VRAM bytes before any GPU-side decoding at all, use ppsspp_read_range over 0x04000000-0x041FFFFF. " +
      "BEHAVIOR: Transparently pauses the CPU/GPU if not already stepping (like ppsspp_screenshot), captures, then resumes. Returns an error if no texture is currently bound. " +
      "RETURNS: 'visual' mode: text (dimensions) + inline PNG. 'raw' mode: text with width/height/format/flipped plus the raw pixel bytes as base64 (NOT a PNG — decode using the stated format).",
    inputSchema: {
      type: "object",
      properties: {
        level: { type: "integer", minimum: 0, description: "Mip level to capture. Default 0 (full resolution)." },
        alpha: { type: "boolean", description: "Include alpha channel in the decoded output, if applicable to the format." },
        mode: { type: "string", enum: ["visual", "raw"], description: "Default 'visual' (inline PNG). 'raw' returns undecoded native pixel bytes + PPSSPP's format descriptor instead." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ppsspp_texture_clut_dump",
    description:
      "PURPOSE: Capture the active CLUT (color lookup table / palette) for the currently-bound paletted texture format. " +
      "USAGE: Companion to ppsspp_texture_dump for 4-bit/8-bit indexed PSP texture formats — get the exact palette PPSSPP is using to decode indices into colors, to compare against your own palette-reading logic (common bug source: palette byte order, entry count, or format mismatch). " +
      "BEHAVIOR: Transparently pauses the CPU/GPU if not already stepping, captures, then resumes. Returns an error if the currently-bound texture isn't a paletted format (no CLUT in use). " +
      "RETURNS: Text with the palette's format descriptor and entry count, plus the raw palette bytes as base64.",
    inputSchema: {
      type: "object",
      properties: {
        alpha: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
];

export const textureTools: ToolModule = {
  tools,
  handlers: {
    ppsspp_texture_dump: async (pp, p) => {
      const mode = (p.mode as string | undefined) ?? "visual";
      const params: Record<string, unknown> = {};
      if (p.level !== undefined) params.level = p.level;
      if (p.alpha !== undefined) params.alpha = p.alpha;

      return withStepping(pp, async () => {
        if (mode === "raw") {
          const r = await callGpuBufferEvent<{ width?: number; height?: number; format?: string; flipped?: boolean; base64?: string }>(
            pp,
            "gpu.buffer.texture",
            { ...params, type: "base64" },
          );
          if (!r.base64) {
            throw new Error("PPSSPP did not return texture data (no texture currently bound? pause at a draw call using one first)");
          }
          return ok(
            `Texture (raw): ${r.width ?? "?"}x${r.height ?? "?"} format=${r.format ?? "?"}${r.flipped ? " (flipped)" : ""}\n` +
            `base64 (${Buffer.from(r.base64, "base64").length} bytes decoded):\n${r.base64}`,
          );
        }
        const r = await callGpuBufferEvent<{ width?: number; height?: number; uri?: string; base64?: string }>(
          pp,
          "gpu.buffer.texture",
          { ...params, type: "uri" },
        );
        const b64 = extractBase64Png(r);
        if (!b64) {
          throw new Error("PPSSPP did not return texture data (no texture currently bound? pause at a draw call using one first)");
        }
        return {
          content: [
            { type: "text" as const, text: `Texture captured: ${r.width ?? "?"}x${r.height ?? "?"}` },
            { type: "image" as const, data: b64, mimeType: "image/png" },
          ],
        };
      });
    },

    ppsspp_texture_clut_dump: async (pp, p) => {
      const params: Record<string, unknown> = {};
      if (p.alpha !== undefined) params.alpha = p.alpha;

      return withStepping(pp, async () => {
        const r = await callGpuBufferEvent<{ width?: number; height?: number; format?: string; base64?: string }>(
          pp,
          "gpu.buffer.clut",
          { ...params, type: "base64" },
        );
        if (!r.base64) {
          throw new Error("PPSSPP did not return CLUT data (currently-bound texture may not be a paletted format)");
        }
        const bytes = Buffer.from(r.base64, "base64");
        return ok(
          `CLUT: ${r.width ?? bytes.length} entries, format=${r.format ?? "?"}\n` +
          `base64 (${bytes.length} bytes decoded):\n${r.base64}`,
        );
      });
    },
  },
};
