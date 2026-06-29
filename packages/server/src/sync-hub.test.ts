// packages/server/src/sync-hub.test.ts
// T17.2 — SyncHub unit tests.

import { describe, expect, it } from "bun:test";
import { SyncHub } from "./sync-hub.js";
import type { SSEWriter } from "./sse-writer.js";
import type { ServerEvent } from "./sse.js";

function fakeWriter(opts: { throws?: boolean } = {}): SSEWriter & { writes: ServerEvent[] } {
  const writes: ServerEvent[] = [];
  let closed = false;
  return {
    writes,
    write(ev) {
      if (closed) return;
      if (opts.throws) throw new Error("write failed");
      writes.push(ev);
    },
    end() { closed = true; },
    get closed() { return closed; },
  };
}

describe("SyncHub", () => {
  it("broadcasts to every subscriber", () => {
    const hub = new SyncHub();
    const a = fakeWriter();
    const b = fakeWriter();
    hub.subscribe(a);
    hub.subscribe(b);

    hub.broadcast({ type: "session_renamed", sessionId: "s1", title: "T" });

    expect(a.writes).toHaveLength(1);
    expect(b.writes).toHaveLength(1);
    expect(a.writes[0]).toEqual({ type: "session_renamed", sessionId: "s1", title: "T" });
  });

  it("no-ops when there are no subscribers", () => {
    const hub = new SyncHub();
    expect(() => hub.broadcast({ type: "error", message: "x" })).not.toThrow();
    expect(hub.subscriberCount()).toBe(0);
  });

  it("unsubscribe stops further delivery to that writer", () => {
    const hub = new SyncHub();
    const a = fakeWriter();
    const b = fakeWriter();
    const unsubA = hub.subscribe(a);
    hub.subscribe(b);

    hub.broadcast({ type: "error", message: "1" });
    expect(a.writes).toHaveLength(1);
    expect(b.writes).toHaveLength(1);

    unsubA();
    hub.broadcast({ type: "error", message: "2" });

    expect(a.writes).toHaveLength(1);
    expect(b.writes).toHaveLength(2);
  });

  it("unsubscribe is idempotent", () => {
    const hub = new SyncHub();
    const a = fakeWriter();
    const unsub = hub.subscribe(a);
    unsub();
    expect(() => unsub()).not.toThrow();
    expect(hub.subscriberCount()).toBe(0);
  });

  it("prunes writers that throw on write", () => {
    const hub = new SyncHub();
    const good = fakeWriter();
    const bad = fakeWriter({ throws: true });
    hub.subscribe(good);
    hub.subscribe(bad);

    hub.broadcast({ type: "error", message: "boom" });

    // bad threw, was pruned; good received the event
    expect(good.writes).toHaveLength(1);
    expect(hub.subscriberCount()).toBe(1);
  });

  it("subscriberCount reflects adds and removes", () => {
    const hub = new SyncHub();
    expect(hub.subscriberCount()).toBe(0);
    const a = fakeWriter();
    const b = fakeWriter();
    const ua = hub.subscribe(a);
    expect(hub.subscriberCount()).toBe(1);
    hub.subscribe(b);
    expect(hub.subscriberCount()).toBe(2);
    ua();
    expect(hub.subscriberCount()).toBe(1);
  });
});