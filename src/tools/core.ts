import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ok, addrHex, PSP_BUTTONS, type ToolModule } from "./shared.js";

const tools: Tool[] = [
  {
    name: "ppsspp_ping",
    description:
      "PURPOSE: Verify that the PPSSPP WebSocket debugger is reachable and responding. " +
      "USAGE: Call once at start-of-session before any other tool calls; if it succeeds, the WebSocket handshake worked and PPSSPP's debugger is available. " +
      "BEHAVIOR: No side effects — calls the 'version' event to learn PPSSPP's release version. Times out after ~10 seconds if PPSSPP isn't running, doesn't have 'Allow remote debugger' enabled (Settings → Tools → Developer Tools), or the host:port isn't reachable. " +
      "RETURNS: Single line 'pong (PPSSPP VERSION)'.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ppsspp_get_info",
    description:
      "PURPOSE: Get the loaded game's title, disc ID, and version, plus PPSSPP's run state. " +
      "USAGE: Call after ppsspp_ping to learn what game is loaded and whether emulation is currently running or stepping. " +
      "BEHAVIOR: No side effects — pure read. Returns 'no game loaded' fields if PPSSPP is at the home menu / not currently emulating. " +
      "RETURNS: Multi-line text with Title, Disc ID, Version, and run state (running / paused / stepping).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ppsspp_press_buttons",
    description:
      "PURPOSE: Set the PSP joypad button state — the buttons in the map are 'held' until you send another buttons command. " +
      "USAGE: Drive games with input. Unlike one-frame-only schemes on other emulators, PPSSPP's input.buttons.send updates the persistent button state — the buttons stay held until you call ppsspp_press_buttons again with them set false (or use ppsspp_press_button for a timed one-shot). To release all buttons, call with all keys set to false. " +
      `BEHAVIOR: Modifies emulator input state until changed. PSP buttons (case-sensitive): ${PSP_BUTTONS.join(", ")}. Unrecognized button names return an error. ` +
      "RETURNS: Single line 'Set buttons: BUTTON+BUTTON+...' or '... (all released)' if nothing was pressed.",
    inputSchema: {
      type: "object",
      required: ["buttons"],
      properties: {
        buttons: {
          type: "object",
          description: `Map of PSP button name → pressed (boolean). Valid names: ${PSP_BUTTONS.join(", ")}. Example: {"cross": true, "right": true} holds X and Right.`,
          additionalProperties: { type: "boolean" },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ppsspp_press_button",
    description:
      "PURPOSE: Press a PSP button for a fixed number of frames, then auto-release. " +
      "USAGE: Use for discrete actions like pressing Start to skip a cutscene, or Cross to confirm a menu. For longer holds across many frames use ppsspp_press_buttons (persistent state) instead. " +
      "BEHAVIOR: Modifies emulator input state. PPSSPP queues the press internally and releases the button after `duration` frames; the tool call returns immediately. Returns an error if the button name isn't recognized. " +
      "RETURNS: Single line 'Pressed BUTTON for N frames (auto-released)'.",
    inputSchema: {
      type: "object",
      required: ["button"],
      properties: {
        button:   { type: "string", description: `PSP button name. Valid: ${PSP_BUTTONS.join(", ")}.` },
        duration: { type: "integer", minimum: 1, default: 1, description: "Number of frames to hold the button before releasing (default 1)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ppsspp_send_analog",
    description:
      "PURPOSE: Set the PSP analog stick state (one of left/right; the PSP only has one stick natively but PPSSPP exposes both for forward-compat). " +
      "USAGE: Drive games that need analog input — character movement, camera control. X and Y are signed in [-1.0, 1.0]; (0, 0) = neutral, (1, 0) = full right, (0, -1) = full up. " +
      "BEHAVIOR: Modifies emulator analog input. State persists until updated. " +
      "RETURNS: Single line 'Set analog stick STICK to (X, Y)'.",
    inputSchema: {
      type: "object",
      required: ["stick", "x", "y"],
      properties: {
        stick: { type: "string", enum: ["left", "right"], description: "Which analog stick to update. PSP only has 'left' natively; 'right' is reserved." },
        x: { type: "number", minimum: -1, maximum: 1, description: "Horizontal axis. -1 = full left, 0 = center, 1 = full right." },
        y: { type: "number", minimum: -1, maximum: 1, description: "Vertical axis. -1 = full down, 0 = center, 1 = full up." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ppsspp_pause",
    description:
      "PURPOSE: Pause PSP emulation (the debugger calls this 'stepping mode'). " +
      "USAGE: Use before a sequence of memory inspects when you need a stable game state across calls. Memory r/w tool calls still work while paused. Use ppsspp_resume to continue. " +
      "BEHAVIOR: Modifies emulator run state. Pauses the MIPS CPU; rendering may continue at last frame. Idempotent — pausing already-paused is a no-op. " +
      "RETURNS: Single line 'Emulation paused'.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ppsspp_resume",
    description:
      "PURPOSE: Resume PSP emulation from a paused/stepping state. " +
      "USAGE: Counterpart to ppsspp_pause. Use after a paused inspection sequence. To step a single frame instead, use ppsspp_step. To resume-and-block-until-the-next-stop in one call, use ppsspp_wait_for_break instead. " +
      "BEHAVIOR: Modifies emulator run state. Idempotent — resuming already-running is a no-op. " +
      "RETURNS: Single line 'Emulation resumed'.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ppsspp_step",
    description:
      "PURPOSE: Step the MIPS CPU forward by ONE instruction (cpu.stepInto). " +
      "USAGE: For instruction-level debugging — set a breakpoint, hit it, then step. NOT a frame-advance — one MIPS instruction is much smaller than one frame. To advance a frame's worth of execution, set a breakpoint at the start of the next frame's render and use ppsspp_resume. " +
      "BEHAVIOR: Modifies emulator run state. Executes one MIPS instruction, then returns to stepping mode. Returns an error if emulation isn't currently in stepping mode (call ppsspp_pause first). " +
      "RETURNS: Single line 'Stepped one instruction. PC: 0xADDR'.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ppsspp_reset",
    description:
      "PURPOSE: Reset the loaded PSP game — equivalent to soft-resetting the console. " +
      "USAGE: Use to start fresh from the game's intro. To return to a specific point, set up a savestate via PPSSPP's UI and load it (savestate API is not in the WebSocket interface, so this must be done via PPSSPP's keybinds — typically F1-F8 for slots). " +
      "BEHAVIOR: DESTRUCTIVE: RAM contents cleared, CPU returns to game entry point, framecount/game-state lost. The ISO/EBOOT stays loaded. " +
      "RETURNS: Single line 'Game reset'.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ppsspp_screenshot",
    description:
      "PURPOSE: Capture the current PSP framebuffer as a PNG-encoded screenshot. " +
      "USAGE: For visual inspection or sequence documentation. Default 'render' source reads the active GPU render target — safer, native 480x272, what the PSP CPU asked the GPU to draw. Opt-in 'output' source reads PPSSPP's final composited output (post scaling/shaders) but can crash PPSSPP on games whose output framebuffer state confuses GPU_GetOutputFramebuffer (a real upstream bug — an _assert_ that should be a graceful failure). Prefer 'render' unless you specifically need the post-processed image. For textures instead of the full frame, use ppsspp_texture_dump. " +
      "BEHAVIOR: Transparently pauses the CPU (cpu.stepping), captures, then resumes — both PPSSPP buffer events require stepping. If the emulator was already paused, leaves it paused. Returns an error if no game is loaded. The 'output' source CAN crash PPSSPP on certain games; if it does, MCP auto-reconnects to the relaunched PPSSPP cleanly. " +
      "RETURNS: Text confirmation + inline PNG image block.",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          enum: ["render", "output"],
          description: "Which GPU buffer to capture. 'render' (default) reads the current render target via gpu.buffer.renderColor — native PSP 480x272, safer on homebrew/edge-case games. 'output' reads the final composited framebuffer via gpu.buffer.screenshot — post-processed (matches what's on screen) but can crash PPSSPP on games where GPU_GetOutputFramebuffer trips its null-buf assertion.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ppsspp_get_registers",
    description:
      "PURPOSE: Read all MIPS Allegrex CPU registers (general-purpose + FPU + special). " +
      "USAGE: For reverse engineering and debugging — inspect function arguments, return values, PC, stack pointer. PSP's calling convention puts args in $a0-$a3, return in $v0, stack in $sp, return address in $ra. " +
      "BEHAVIOR: No side effects — pure read. Most informative when called while emulation is paused (ppsspp_pause first); on a running CPU the snapshot is from whenever PPSSPP samples it. " +
      "RETURNS: Multi-line text with all register names + hex values, grouped by class (GPR, FPU, special).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ppsspp_set_register",
    description:
      "PURPOSE: Write a single MIPS Allegrex CPU register — set a GPR, PC, HI/LO, or FPU register to a new value. " +
      "USAGE: The write counterpart to ppsspp_get_registers. Use during debugging to redirect execution (set `pc`), fix a return value (`v0`), patch an argument before a call (`a0`-`a3`), adjust the stack pointer (`sp`), or poke an FPU register. BEST DONE WHILE PAUSED (ppsspp_pause, or stopped at a breakpoint) — writing a register on a running CPU races the next instruction that overwrites it. Register names match ppsspp_get_registers output (GPRs zero/at/v0/v1/a0-a3/t0-t9/s0-s7/k0/k1/gp/sp/fp/ra, special pc/hi/lo, FPU f0-f31). " +
      "BEHAVIOR: DESTRUCTIVE to CPU state — no undo (snapshot via ppsspp_get_registers first if you need the old value). Maps to PPSSPP's cpu.setReg. Returns an error if the register name is unknown or no game is loaded. " +
      "RETURNS: Single line confirming the register and the value written.",
    inputSchema: {
      type: "object",
      required: ["register", "value"],
      properties: {
        register: { type: "string", description: "Register name as shown by ppsspp_get_registers — e.g. 'pc', 'v0', 'a0', 'sp', 'ra', 'f0'. Case-insensitive per PPSSPP." },
        value: {
          type: ["integer", "string"],
          description: "New value. A JSON integer for the common case (32-bit; encode signed values as two's-complement uint), or a string for hex ('0x1F'), float ('1.5'), or special ('nan','inf','-inf') forms — PPSSPP parses all of these.",
        },
      },
      additionalProperties: false,
    },
  },
];

export const coreTools: ToolModule = {
  tools,
  handlers: {
    ppsspp_ping: async (pp) => {
      const r = await pp.call<{ version?: string; name?: string }>("version");
      return ok(`pong (${r.name ?? "PPSSPP"} ${r.version ?? "(unknown version)"})`);
    },

    ppsspp_get_info: async (pp) => {
      const status = await pp.call<{ game?: { id?: string; title?: string; version?: string } | null; paused?: boolean; stepping?: boolean }>("game.status");
      const lines: string[] = [];
      if (status.game) {
        lines.push(`Title:   ${status.game.title ?? "(unavailable)"}`);
        lines.push(`Disc ID: ${status.game.id ?? "(unavailable)"}`);
        lines.push(`Version: ${status.game.version ?? "(unavailable)"}`);
      } else {
        lines.push("No game loaded.");
      }
      const state = status.stepping ? "stepping (paused)" : status.paused ? "paused" : "running";
      lines.push(`State:   ${state}`);
      return ok(lines.join("\n"));
    },

    ppsspp_press_buttons: async (pp, p) => {
      await pp.call("input.buttons.send", { buttons: p.buttons });
      const pressed = Object.entries(p.buttons as Record<string, boolean>)
        .filter(([, v]) => v).map(([k]) => k);
      return ok(`Set buttons: ${pressed.length ? pressed.join("+") : "(all released)"}`);
    },
    ppsspp_press_button: async (pp, p) => {
      await pp.call("input.buttons.press", { button: p.button, duration: p.duration ?? 1 });
      return ok(`Pressed ${p.button} for ${p.duration ?? 1} frames (auto-released)`);
    },
    ppsspp_send_analog: async (pp, p) => {
      await pp.call("input.analog.send", { stick: p.stick, x: p.x, y: p.y });
      return ok(`Set analog stick ${p.stick} to (${p.x}, ${p.y})`);
    },

    ppsspp_pause: async (pp) => {
      // cpu.stepping is fire-and-forget per PPSSPP source ("No immediate
      // response. Once CPU is stepping, a 'cpu.stepping' event will be
      // sent."). Send it, then poll cpu.status until stepping=true.
      await pp.fireAndForget("cpu.stepping");
      await pp.waitForState((s) => s.stepping === true);
      return ok("Emulation paused");
    },
    ppsspp_resume: async (pp) => {
      await pp.fireAndForget("cpu.resume");
      await pp.waitForState((s) => s.stepping === false);
      return ok("Emulation resumed");
    },
    ppsspp_step: async (pp) => {
      const r = await pp.call<{ pc?: number }>("cpu.stepInto");
      return ok(`Stepped one instruction. PC: ${r.pc !== undefined ? addrHex(r.pc) : "(unknown)"}`);
    },
    ppsspp_reset: async (pp) => {
      await pp.call("game.reset");
      return ok("Game reset");
    },

    ppsspp_screenshot: async (pp, p) => {
      // PPSSPP's gpu.buffer.* events all require CORE_STEPPING_CPU (or GPU
      // stepping) state — they fail with "Neither CPU or GPU is stepping"
      // otherwise. We transparently pause→capture→resume so callers can
      // screenshot any time without managing pause state. If the emulator
      // was already paused, we leave it paused.
      //
      // source='render' (default) uses gpu.buffer.renderColor → reads the
      // active GPU render target. Safer: GPU_GetCurrentFramebuffer hits a
      // different code path than the crash-prone GPU_GetOutputFramebuffer.
      //
      // source='output' uses gpu.buffer.screenshot → reads the final
      // composited output (what's on screen, post scaling/shaders). Can
      // CRASH PPSSPP on some games: upstream has an `_assert_(buf != nullptr)`
      // after GPU_GetOutputFramebuffer that fires when the function returns
      // true with a null buffer (observed on some homebrew). We can't catch
      // a process abort from outside, but v0.1.2's auto-reconnect means MCP
      // recovers when PPSSPP is relaunched.
      const source = (p.source as string | undefined) ?? "render";
      const event  = source === "output" ? "gpu.buffer.screenshot" : "gpu.buffer.renderColor";
      const statusBefore = await pp.call<{ stepping?: boolean; paused?: boolean }>("cpu.status");
      const wasStepping = !!statusBefore.stepping;
      if (!wasStepping) {
        await pp.fireAndForget("cpu.stepping");
        await pp.waitForState((s) => s.stepping === true);
      }
      try {
        // type: "base64" returns the raw base64 payload; the default "uri"
        // returns a "data:image/png;base64,..." prefix which we'd have to strip.
        const r = await pp.call<{ base64?: string; uri?: string }>(event, { type: "base64" });
        let b64 = r.base64;
        if (!b64 && r.uri) {
          // Belt-and-suspenders: if PPSSPP returned a URI anyway, strip the prefix.
          const m = /^data:image\/png;base64,(.*)$/.exec(r.uri);
          if (m) b64 = m[1];
        }
        if (!b64) {
          throw new Error(`PPSSPP did not return screenshot data from ${event} (no game loaded, or framebuffer not readable?)`);
        }
        return {
          content: [
            { type: "text" as const, text: `Screenshot captured (source: ${source}, event: ${event}).` },
            { type: "image" as const, data: b64, mimeType: "image/png" },
          ],
        };
      } finally {
        if (!wasStepping) {
          try {
            await pp.fireAndForget("cpu.resume");
            await pp.waitForState((s) => s.stepping === false, { timeoutMs: 2000 });
          } catch { /* best-effort */ }
        }
      }
    },

    ppsspp_get_registers: async (pp) => {
      // PPSSPP's cpu.getAllRegs returns categories with PARALLEL arrays:
      //   { categories: [{ name, registerNames: [...], uintValues: [...], floatValues: [...] }] }
      // Not an array of {name, value} objects as I first assumed.
      const r = await pp.call<{
        categories?: Array<{
          name: string;
          registerNames?: string[];
          uintValues?: number[];
          floatValues?: string[];
        }>;
      }>("cpu.getAllRegs");
      const lines: string[] = [];
      for (const cat of r.categories ?? []) {
        lines.push(`── ${cat.name} ──`);
        const names = cat.registerNames ?? [];
        const vals  = cat.uintValues ?? [];
        for (let i = 0; i < Math.max(names.length, vals.length); i++) {
          const nm = names[i] ?? `r${i}`;
          const v  = vals[i];
          lines.push(`  ${nm.padEnd(8)} = ${v !== undefined ? addrHex(v) : "(unavailable)"}`);
        }
      }
      return ok(lines.join("\n") || "(no registers returned)");
    },

    ppsspp_set_register: async (pp, p) => {
      const reg = p.register as string;
      const r = await pp.call<{ uintValue?: number; floatValue?: string }>(
        "cpu.setReg",
        { name: reg, value: p.value },
      );
      const confirmed = r.uintValue !== undefined
        ? addrHex(r.uintValue)
        : (r.floatValue !== undefined ? r.floatValue : String(p.value));
      return ok(`Set ${reg} = ${confirmed}`);
    },
  },
};
