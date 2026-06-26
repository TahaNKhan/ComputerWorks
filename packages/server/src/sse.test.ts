// packages/server/src/sse.test.ts
// Unit tests for SSEManager + formatSSE.
//
// Design rules:
//   1. Every test that creates an SSEManager runs it inside a try/finally
//      so `shutdown()` always fires — leaked intervals / subscribers are
//      the most common cause of "process won't exit" hangs in this file.
//   2. Every consumer is bounded by a `Promise.race` against a `withTimeout`
//      helper so a forgotten waiter can't hang the suite. Default race
//      timeout is 1000 ms, which is well under bun:test's own 5 s per-test
//      limit and aborts cleanly with an explicit failure message.
//   3. We never use `for await (const x of sub) { ... break; }` to drain
//      streams — that pattern depends on timing. Instead, each test
//      collects a fixed, known number of events and asserts on the result.
//   4. Heartbeat tests use a tiny `heartbeatMs` (10 ms) and never depend
//      on exact event ordering between real events and heartbeats.

import { afterEach, describe, expect, it } from "bun:test";
import { formatSSE, SSEManager } from "./sse.js";

// ─── helpers ────────────────────────────────────────────────────────────────

const dec = (u: Uint8Array): string => new TextDecoder().decode(u);

/** Race a promise against a timeout. On timeout, throw so the test fails
 *  with a clear message instead of hanging the whole suite. */
async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Run `body` with a fresh SSEManager, guaranteeing shutdown. Body first
 *  so callers can drop the options arg entirely. */
async function withManager<T>(
  body: (mgr: SSEManager) => Promise<T>,
  opts: { heartbeatMs?: number } = {},
): Promise<T> {
  const mgr = new SSEManager(opts);
  try {
    return await body(mgr);
  } finally {
    mgr.shutdown();
  }
}

interface SubHandle {
  dispose(): void;
  iterator(): AsyncIterator<Uint8Array>;
}

/** Wrap `mgr.subscribe(id)` so tests don't need to remember to dispose. */
function trackedSub(mgr: SSEManager, id: string): SubHandle {
  const sub = mgr.subscribe(id);
  return {
    dispose: () => sub.dispose(),
    iterator: () => sub[Symbol.asyncIterator](),
  };
}

// Track managers created in a test (for non-withManager tests) so a
// forgotten shutdown can't leak. We add to this set inline; afterEach
// sweeps anything left.
const tracked = new Set<SSEManager>();
afterEach(() => {
  for (const m of tracked) m.shutdown();
  tracked.clear();
});

// ─── formatSSE ─────────────────────────────────────────────────────────────

describe("formatSSE", () => {
  it("frames a token event", () => {
    const text = dec(formatSSE({ type: "token", delta: "Hello" }));
    expect(text.startsWith("event: token\n")).toBe(true);
    expect(text).toContain('data: {"delta":"Hello"}');
    expect(text.endsWith("\n\n")).toBe(true);
  });

  it("frames a done event with an empty data line", () => {
    expect(dec(formatSSE({ type: "done" }))).toBe("event: done\ndata: \n\n");
  });

  it("frames an error event", () => {
    const text = dec(formatSSE({ type: "error", message: "boom" }));
    expect(text).toContain("event: error");
    expect(text).toContain('"message":"boom"');
  });

  it("frames an approval_required with description and optional diff", () => {
    const text = dec(
      formatSSE({
        type: "approval_required",
        requestId: "r1",
        tool: {
          type: "tool_use",
          id: "t1",
          name: "run_shell",
          input: { cmd: "ls" },
        },
        description: "Run ls",
        diff: "--- a\n+++ b",
      }),
    );
    expect(text).toContain("event: approval_required");
    expect(text).toContain('"requestId":"r1"');
    expect(text).toContain('"diff":"--- a');
  });

  it("frames a session_renamed event", () => {
    const text = dec(
      formatSSE({
        type: "session_renamed",
        sessionId: "abc",
        title: "My Chat",
      }),
    );
    expect(text).toContain("event: session_renamed");
    expect(text).toContain('"sessionId":"abc"');
    expect(text).toContain('"title":"My Chat"');
  });
});

// ─── subscribe + send ──────────────────────────────────────────────────────

describe("subscribe + send", () => {
  it("delivers events sent to the same session", async () => {
    await withManager(async (mgr) => {
      const s = trackedSub(mgr, "s1");
      mgr.send("s1", { type: "token", delta: "hi" });
      mgr.send("s1", { type: "done" });
      const events: string[] = [];
      const it = s.iterator();
      await withTimeout(
        (async () => {
          while (events.length < 2) {
            const r = await it.next();
            if (r.done) return;
            if (r.value) events.push(dec(r.value));
          }
        })(),
        1000,
        "read 2 events",
      );
      s.dispose();
      expect(events).toHaveLength(2);
      expect(events[0]).toContain('"delta":"hi"');
      expect(events[1]).toContain("event: done");
    });
  });

  it("supports multiple subscribers on the same session", async () => {
    await withManager(async (mgr) => {
      const a = trackedSub(mgr, "s1");
      const b = trackedSub(mgr, "s1");
      mgr.send("s1", { type: "token", delta: "x" });
      const [ra, rb] = await Promise.all([
        withTimeout(a.iterator().next(), 1000, "a.next").then((r) =>
          r.done ? "" : dec(r.value as Uint8Array),
        ),
        withTimeout(b.iterator().next(), 1000, "b.next").then((r) =>
          r.done ? "" : dec(r.value as Uint8Array),
        ),
      ]);
      a.dispose();
      b.dispose();
      expect(ra).toContain('"delta":"x"');
      expect(rb).toContain('"delta":"x"');
    });
  });

  it("does not cross streams between sessions", async () => {
    await withManager(async (mgr) => {
      const a = trackedSub(mgr, "s1");
      const b = trackedSub(mgr, "s2");
      mgr.send("s1", { type: "token", delta: "for-s1" });
      mgr.send("s2", { type: "token", delta: "for-s2" });
      const [ra, rb] = await Promise.all([
        withTimeout(a.iterator().next(), 1000, "a.next").then((r) =>
          r.done ? "" : dec(r.value as Uint8Array),
        ),
        withTimeout(b.iterator().next(), 1000, "b.next").then((r) =>
          r.done ? "" : dec(r.value as Uint8Array),
        ),
      ]);
      a.dispose();
      b.dispose();
      expect(ra).toContain("for-s1");
      expect(ra).not.toContain("for-s2");
      expect(rb).toContain("for-s2");
      expect(rb).not.toContain("for-s1");
    });
  });

  it("subscriberCount tracks subscribers and dispose removes them", () => {
    const mgr = new SSEManager();
    tracked.add(mgr);
    expect(mgr.subscriberCount("s1")).toBe(0);
    const a = trackedSub(mgr, "s1");
    const b = trackedSub(mgr, "s1");
    expect(mgr.subscriberCount("s1")).toBe(2);
    a.dispose();
    expect(mgr.subscriberCount("s1")).toBe(1);
    b.dispose();
    expect(mgr.subscriberCount("s1")).toBe(0);
  });

  it("send to a session with no subscribers is a no-op", () => {
    const mgr = new SSEManager();
    tracked.add(mgr);
    expect(() => mgr.send("nobody", { type: "done" })).not.toThrow();
    expect(mgr.subscriberCount("nobody")).toBe(0);
  });
});

// ─── closeSession ──────────────────────────────────────────────────────────

describe("closeSession", () => {
  it("ends all subscribers of the session", async () => {
    await withManager(async (mgr) => {
      const a = trackedSub(mgr, "s1");
      const b = trackedSub(mgr, "s1");
      mgr.closeSession("s1");
      // After close, both iterators must return {done:true} promptly.
      const ra = await withTimeout(a.iterator().next(), 500, "a.next");
      const rb = await withTimeout(b.iterator().next(), 500, "b.next");
      expect(ra.done).toBe(true);
      expect(rb.done).toBe(true);
      expect(mgr.subscriberCount("s1")).toBe(0);
    });
  });

  it("does not affect other sessions", async () => {
    await withManager(async (mgr) => {
      const a = trackedSub(mgr, "s1");
      const b = trackedSub(mgr, "s2");
      mgr.closeSession("s1");
      const ra = await withTimeout(a.iterator().next(), 500, "a.next");
      expect(ra.done).toBe(true);
      expect(mgr.subscriberCount("s2")).toBe(1);
      b.dispose();
    });
  });
});

// ─── dispose ───────────────────────────────────────────────────────────────

describe("subscribe().dispose", () => {
  it("removes the subscriber from the manager", () => {
    const mgr = new SSEManager();
    tracked.add(mgr);
    const s = trackedSub(mgr, "s1");
    expect(mgr.subscriberCount("s1")).toBe(1);
    s.dispose();
    expect(mgr.subscriberCount("s1")).toBe(0);
  });

  it("dispose() wakes a consumer that was awaiting next()", async () => {
    await withManager(async (mgr) => {
      const s = trackedSub(mgr, "s1");
      const pending = s.iterator().next();
      // Give the consumer a tick to enter the awaiting state.
      await new Promise((r) => setTimeout(r, 5));
      s.dispose();
      const result = await withTimeout(pending, 500, "pending.next");
      expect(result.done).toBe(true);
    });
  });
});

// ─── heartbeat ─────────────────────────────────────────────────────────────

describe("heartbeat", () => {
  it("emits a heartbeat to an idle subscriber", async () => {
    await withManager(
      async (mgr) => {
        const s = trackedSub(mgr, "s1");
        let got = "";
        await withTimeout(
          (async () => {
            const it = s.iterator();
            for (;;) {
              const result = await it.next();
              if (result.done) return;
              const text = result.value ? dec(result.value) : "";
              if (text.startsWith(":hb")) {
                got = text;
                return;
              }
            }
          })(),
          1000,
          "heartbeat",
        );
        s.dispose();
        expect(got).toBe(":hb\n\n");
      },
      { heartbeatMs: 10 },
    );
  });

  it("delivers queued events ahead of heartbeats", async () => {
    await withManager(
      async (mgr) => {
        // Subscribe FIRST so sends land in the queue (not nowhere).
        const s = trackedSub(mgr, "s1");
        mgr.send("s1", { type: "token", delta: "first" });
        mgr.send("s1", { type: "token", delta: "second" });
        const it = s.iterator();
        const events: string[] = [];
        await withTimeout(
          (async () => {
            while (events.length < 2) {
              const r = await it.next();
              if (r.done) return;
              if (r.value) events.push(dec(r.value));
            }
          })(),
          1000,
          "read 2 events",
        );
        s.dispose();
        expect(events[0]).toContain('"delta":"first"');
        expect(events[1]).toContain('"delta":"second"');
      },
      { heartbeatMs: 10 },
    );
  });
});

// ─── backpressure ──────────────────────────────────────────────────────────

describe("backpressure", () => {
  it("drops a subscriber whose queue overflows", async () => {
    await withManager(async (mgr) => {
      const s = trackedSub(mgr, "s1");
      // MAX_QUEUE is 1000; the 1001st event triggers the drop.
      for (let i = 0; i < 1000; i++) {
        mgr.send("s1", { type: "token", delta: String(i) });
      }
      mgr.send("s1", { type: "token", delta: "overflow" });
      // The subscriber is dropped synchronously by send().
      expect(mgr.subscriberCount("s1")).toBe(0);
      // Drain whatever was queued; should end promptly and stay bounded.
      const it = s.iterator();
      let count = 0;
      await withTimeout(
        (async () => {
          for (;;) {
            const r = await it.next();
            if (r.done) return;
            if (r.value) count++;
          }
        })(),
        500,
        "drain dropped",
      );
      expect(count).toBeLessThanOrEqual(1001);
    });
  });
});

// ─── shutdown ──────────────────────────────────────────────────────────────

describe("shutdown", () => {
  it("closes all subscribers and is safe to call twice", () => {
    const mgr = new SSEManager();
    trackedSub(mgr, "s1");
    trackedSub(mgr, "s2");
    mgr.shutdown();
    expect(mgr.subscriberCount("s1")).toBe(0);
    expect(mgr.subscriberCount("s2")).toBe(0);
    mgr.shutdown();
  });
});