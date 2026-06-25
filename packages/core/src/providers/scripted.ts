// packages/core/src/providers/scripted.ts
// T1.4 — Scripted test provider. Plays back a pre-canned list of
// StreamEvent sequences. Used by every later test to avoid network calls.
//
// The provider is driven by a "script" — a list of frames. Each frame
// is a list of events to yield. The provider yields events in order
// for one frame, then advances to the next on the next `chat()` call.
// This lets a test express "first turn: tool_call X; second turn:
// text tokens".

import type { Provider, ChatRequest } from "../provider.js";
import type { StreamEvent } from "../types.js";

export interface ScriptedProviderScript {
  /** Sequence of frames. Each frame is consumed by one `chat()` call. */
  frames: StreamEvent[][];
}

export function createScriptedProvider(
  script: ScriptedProviderScript,
): Provider {
  let cursor = 0;

  async function* playOneFrame(): AsyncGenerator<StreamEvent, void, void> {
    if (cursor >= script.frames.length) {
      // No more scripted events — end the stream cleanly.
      return;
    }
    const frame = script.frames[cursor]!;
    cursor += 1;
    for (const ev of frame) {
      yield ev;
    }
  }

  return {
    id: "scripted",
    capabilities: {
      toolUse: true,
      promptCaching: false,
      vision: false,
    },
    chat(_req: ChatRequest): AsyncIterable<StreamEvent> {
      // Honor the abort signal: stop iterating when signalled.
      const signal = _req.signal;
      return {
        [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
          const it = playOneFrame();
          return {
            async next(): Promise<IteratorResult<StreamEvent>> {
              if (signal?.aborted) {
                return { value: undefined, done: true };
              }
              return it.next();
            },
            async return(): Promise<IteratorResult<StreamEvent>> {
              if (typeof it.return === "function") {
                return it.return();
              }
              return { value: undefined, done: true };
            },
          };
        },
      };
    },
  };
}
