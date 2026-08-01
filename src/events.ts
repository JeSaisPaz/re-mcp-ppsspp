// Typed shapes for PPSSPP's async WebSocket broadcasts (messages with no
// `ticket` field — see ppsspp.ts's onMessage). No runtime code here, just
// contracts for consumers of PpssppClient's EventEmitter surface.
//
// Verified against PPSSPP's actual source (Core/Debugger/WebSocket/*.cpp):
// only the EVENT NAMES below are confirmed from source. The exact broadcast
// payload shape (which fields PPSSPP actually includes when it pushes these
// unprompted, as opposed to what a ticketed `call()` reply carries) has not
// been verified against a live PPSSPP instance — treat the fields below as
// best-effort/optional until confirmed live.

/** Fired whenever the CPU enters stepping mode — a breakpoint or watchpoint
 *  was hit, a step completed, or something called `cpu.stepping` (including
 *  our own PpssppClient). Same event name whether it's a broadcast or the
 *  ack for an outbound `cpu.stepping` request. */
export interface CpuSteppingBroadcast {
  event: "cpu.stepping";
  pc?: number;
  ticks?: number;
}

/** Fired when game load state changes (game started, stopped, etc). */
export interface GameStatusBroadcast {
  event: "game.status";
  game?: { id?: string; title?: string; version?: string } | null;
  paused?: boolean;
  stepping?: boolean;
}

/** Fired for PPSSPP's internal log lines when a client is attached. */
export interface LogBroadcast {
  event: "log";
  level?: string;
  message?: string;
  channel?: string;
}

/** Union of the broadcast shapes we know the name of. PPSSPP may emit
 *  other event categories (config, replay, input) not modeled here — those
 *  still arrive via the "broadcast" catch-all event with their raw shape. */
export type KnownBroadcast = CpuSteppingBroadcast | GameStatusBroadcast | LogBroadcast;
