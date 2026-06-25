// packages/server/src/sse.test.ts
// T5.4 unit tests — SSEManager.
//
// Coverage:
//   - formatSSE produces a valid frame for every event type
//   - subscribe() yields events as they arrive
//   - multiple subscribers to the same session both receive events
//   - subscribers on different sessions don't see each other's events
//   - dispose() removes the subscriber
//   - closeSession() ends all subscribers for that session
//   - heartbeat fires on idle streams (with custom short interval)
//   - heartbeat does NOT interleave when a real event is queued
//   - backpressure drops a slow subscriber
//   - for-await-of's return() path auto-cleans the subscriber

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { formatSSE, SSEManager } from "./sse.js";

const dec = (u: Uint8Array) => new TextDecoder().decode(u);

afterEach(() => {
  // No-op; per-test shutdown() handles cleanup.
});

// ─── formatSSE ────────────────────────────────────────────────────────────

describe("formatSSE", () => {
  it("formats a token event as 'event: token\\ndata: {...}\\n\\n'", () => {
    const bytes = formatSSE({ type: "token", delta: "Hello" });
    const text = dec(bytes);
    expect(text).toMatch(/^event: token\n/);
    expect(text).toContain('data: {"delta":"Hello"}');
    expect(text.endsWith("\n\n")).toBe(true);
  });

  it("formats a 'done' event with an empty data line", () => {
    const text = dec(formatSSE({ type: "done" }));
    expect(text).toMatch(/^event: done\ndata: \n\n$/);
  });

  it("formats an error event with the message", () => {
    const text = dec(formatSSE({ type: "error", message: "boom" }));
    expect(text).toContain('event: error');
    expect(text).toContain('"message":"boom"');
  });

  it("formats an approval_required with description and optional diff", () => {
    const text = dec(
      formatSSE({
        type: "approval_required",
        requestId: "r1",
        tool: { type: "tool_use", id: "t1", name: "run_shell", input: { cmd: "ls" } },
        description: "Run ls",
        diff: "--- a\n+++ b",
      }),
    );
    expect(text).toContain('event: approval_required');
    expect(text).toContain('"requestId":"r1"');
    expect(text).toContain('"diff":"--- a');
  });
});

// ─── subscribe + send ─────────────────────────────────────────────────────

describe("SSEManager.subscribe + send", () => {
  it("yields events sent to the session", async () => {
    const mgr = new SSEManager();
    const sub = mgr.subscribe("s1");
    mgr.send("s1", { type: "token", delta: "hi" });
    mgr.send("s1", { type: "done" });
    const events: string[] = [];
    for await (const u of sub) {
      events.push(dec(u));
      if (dec(u).includes("done")) break;
    }
    expect(events.length).toBe(2);
    expect(events[0]).toContain('"delta":"hi"');
    expect(events[1]).toContain("event: done");
    mgr.shutdown();
  });

  it("supports multiple subscribers to the same session", async () => {
    const mgr = new SSEManager();
    const a = mgr.subscribe("s1");
    const b = mgr.subscribe("s1");
    mgr.send("s1", { type: "token", delta: "x" });
    // Drain both.
    const consume = async (it: AsyncIterable<Uint8Array>) => {
      for await (const u of it) return dec(u);
      return "";
    };
    const [ra, rb] = await Promise.all([consume(a), consume(b)]);
    expect(ra).toContain('"delta":"x"');
    expect(rb).toContain('"delta":"x"');
    mgr.shutdown();
  });

  it("does not cross streams between sessions", async () => {
    const mgr = new SSEManager();
    const a = mgr.subscribe("s1");
    const b = mgr.subscribe("s2");
    mgr.send("s1", { type: "token", delta: "for-s1" });
    mgr.send("s2", { type: "token", delta: "for-s2" });
    const [ra, rb] = await Promise.all([
      (async () => { for await (const u of a) return dec(u); return ""; })(),
      (async () => { for await (const u of b) return dec(u); return ""; })(),
    ]);
    expect(ra).toContain('"delta":"for-s1"');
    expect(rb).toContain('"delta":"for-s2"');
    expect(ra).not.toContain('"for-s2"');
    expect(rb).not.toContain('"for-s1"');
    mgr.shutdown();
  });

  it("subscriberCount tracks subscribers", () => {
    const mgr = new SSEManager();
    expect(mgr.subscriberCount("s1")).toBe(0);
    const a = mgr.subscribe("s1");
    const b = mgr.subscribe("s1");
    expect(mgr.subscriberCount("s1")).toBe(2);
    a.dispose();
    expect(mgr.subscriberCount("s1")).toBe(1);
    b.dispose();
    expect(mgr.subscriberCount("s1")).toBe(0);
    mgr.shutdown();
  });

  it("send is a no-op when there are no subscribers", () => {
    const mgr = new SSEManager();
    expect(() =>
      mgr.send("nobody", { type: "done" }),
    ).not.toThrow();
    mgr.shutdown();
  });
});

// ─── closeSession ─────────────────────────────────────────────────────────

describe("SSEManager.closeSession", () => {
  it("ends all subscribers of the session", async () => {
    const mgr = new SSEManager();
    const a = mgr.subscribe("s1");
    const b = mgr.subscribe("s1");
    mgr.closeSession("s1");
    const consume = async (it: AsyncIterable<Uint8Array>) => {
      for await (const _u of it) {
        // drain
      }
    };
    await consume(a);
    await consume(b);
    expect(mgr.subscriberCount("s1")).toBe(0);
    mgr.shutdown();
  });

  it("does not affect other sessions", async () => {
    const mgr = new SSEManager();
    const a = mgr.subscribe("s1");
    mgr.subscribe("s2");
    mgr.closeSession("s1");
    // a should be closed…
    let aEnded = false;
    for await (const _ of a) {
      // ends
    }
    aEnded = true;
    expect(aEnded).toBe(true);
    // …but s2 still has 1 subscriber.
    expect(mgr.subscriberCount("s2")).toBe(1);
    mgr.shutdown();
  });
});

// ─── dispose ──────────────────────────────────────────────────────────────

describe("subscribe().dispose", () => {
  it("removes the subscriber from the manager", () => {
    const mgr = new SSEManager();
    const sub = mgr.subscribe("s1");
    expect(mgr.subscriberCount("s1")).toBe(1);
    sub.dispose();
    expect(mgr.subscriberCount("s1")).toBe(0);
    mgr.shutdown();
  });

  it("dispose() while a consumer is awaiting wakes the consumer", async () => {
    const mgr = new SSEManager();
    const sub = mgr.subscribe("s1");
    expect(mgr.subscriberCount("s1")).toBe(1);
    // Start a consumer that will block on next() forever.
    const consumer = (async () => {
      for await (const _u of sub) {
        // unreachable — no events are sent
      }
      return "ended";
    })();
    // Give the consumer a chance to enter the awaiting next().
    await new Promise((r) => setTimeout(r, 10));
    expect(mgr.subscriberCount("s1")).toBe(1);
    sub.dispose();
    const result = await consumer;
    expect(result).toBe("ended");
    expect(mgr.subscriberCount("s1")).toBe(0);
    mgr.shutdown();
  });
});

// ─── heartbeat ────────────────────────────────────────────────────────────

describe("SSEManager heartbeat", () => {
  it("emits a heartbeat to an idle subscriber", async () => {
    const mgr = new SSEManager({ heartbeatMs: 30 });
    const sub = mgr.subscribe("s1");
    // Start consuming but don't take the next event.
    const consumer = (async () => {
      for await (const u of sub) {
        const text = dec(u);
        if (text.startsWith(":hb")) return text;
        if (text.startsWith("event:")) continue;
      }
      return "";
    })();
    // Wait for one heartbeat tick.
    const text = await consumer;
    expect(text).toBe(":hb\n\n");
    mgr.shutdown();
  });

  it("queues a real event ahead of a later heartbeat", async () => {
    const mgr = new SSEManager({ heartbeatMs: 30 });
    const sub = mgr.subscribe("s1");
    // First, consume one event (this puts the consumer into "waiting").
    const consumer = (async () => {
      const got: string[] = [];
      for await (const u of sub) {
        got.push(dec(u));
        if (got.length >= 2) return got;
      }
      return got;
    })();
    // Give the consumer a moment to enter awaiting state.
    await new Promise((r) => setTimeout(r, 5));
    mgr.send("s1", { type: "token", delta: "first" });
    mgr.send("s1", { type: "token", delta: "second" });
    const got = await consumer;
    expect(got.length).toBe(2);
    expect(got[0]).toContain('"delta":"first"');
    expect(got[1]).toContain('"delta":"second"');
    mgr.shutdown();
  });
});

// ─── backpressure ─────────────────────────────────────────────────────────

describe("SSEManager backpressure", () => {
  it("drops a subscriber whose queue overflows", async () => {
    const mgr = new SSEManager();
    const sub = mgr.subscribe("s1");
    // 1000 events to fill the queue (MAX_QUEUE = 1000).
    for (let i = 0; i < 1000; i++) {
      mgr.send("s1", { type: "token", delta: String(i) });
    }
    // The 1001st should trigger the drop.
    mgr.send("s1", { type: "token", delta: "overflow" });
    expect(mgr.subscriberCount("s1")).toBe(0);
    // Consume (should end immediately).
    let count = 0;
    for await (const _u of sub) count++;
    expect(count).toBeLessThan(1001);
    mgr.shutdown();
  });
});

// ─── shutdown ─────────────────────────────────────────────────────────────

describe("SSEManager.shutdown", () => {
  it("closes all subscribers and stops the heartbeat", () => {
    const mgr = new SSEManager();
    const a = mgr.subscribe("s1");
    const b = mgr.subscribe("s2");
    mgr.shutdown();
    expect(mgr.subscriberCount("s1")).toBe(0);
    expect(mgr.subscriberCount("s2")).toBe(0);
    // Should be safe to call twice.
    mgr.shutdown();
  });
});
