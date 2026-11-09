import { afterEach, describe, expect, test } from "vitest";
import { MATHML_NS } from "./mathAllow";
import { createMathRenderer, startMathWorker } from "./mathRender";
import type { MathReply, MathRequest, MathTree } from "./mathTree";

/**
 * Decision 101, rule 5. Temml runs in a dedicated worker and the page gives
 * each formula a deadline. These tests run the real worker (Vitest serves it
 * unbundled, as a module worker, the way the build ships it) and, where the
 * order of events matters, a fake that answers when the test says so.
 */

type Renderer = ReturnType<typeof createMathRenderer>;
type Options = NonNullable<Parameters<typeof createMathRenderer>[0]>;
type Maker = NonNullable<Options["createWorker"]>;

const made: Renderer[] = [];
/** A renderer that the test cleans up, so no worker outlives its test. */
function renderer(options: Options = {}): Renderer {
  const r = createMathRenderer(options);
  made.push(r);
  return r;
}

afterEach(() => {
  for (const r of made.splice(0)) r.dispose();
});

/** `\a` pastes its argument `r` times, `\b` calls it with `a` letters, and `u` uses of `\b` follow. */
const bomb = (r: number, a: number, u: number) =>
  `\\def\\a#1{${"#1".repeat(r)}}\\def\\b{\\a{${"x".repeat(a)}}}${"\\b".repeat(u)}`;

/** A worker that does what a test tells it, behind the three methods the renderer uses. */
class FakeWorker extends EventTarget {
  posts: MathRequest[] = [];
  postedAt = 0;
  terminated = false;
  private announced: boolean;
  constructor(
    private onRequest: (worker: FakeWorker, request: MathRequest) => void = () => undefined,
    saysReady = true,
  ) {
    super();
    this.announced = !saysReady;
  }
  // A real worker says `ready` after the page has attached its listeners, never before.
  override addEventListener(...args: Parameters<EventTarget["addEventListener"]>): void {
    super.addEventListener(...args);
    if (!this.announced) {
      this.announced = true;
      queueMicrotask(() => this.say({ kind: "ready" }));
    }
  }
  postMessage(request: MathRequest): void {
    this.posts.push(request);
    this.postedAt = performance.now();
    setTimeout(() => this.onRequest(this, request), 0);
  }
  terminate(): void {
    this.terminated = true;
  }
  say(data: MathReply): void {
    if (!this.terminated) this.dispatchEvent(new MessageEvent("message", { data }));
  }
  crash(): void {
    this.dispatchEvent(new Event("error"));
  }
}

const mi = (text: string): MathTree => ({
  name: "math",
  attributes: [],
  children: [{ name: "mi", attributes: [], children: [text] }],
});

/** A fake that answers every request with `mi(text)`. */
const answering = (text = "x") =>
  new FakeWorker((worker, request) => worker.say({ kind: "tree", id: request.id, tree: mi(text) }));

/** Hands out the fakes in order and counts them. */
function factory(...fakes: FakeWorker[]): { make: Maker; count: () => number } {
  let used = 0;
  return {
    make: () => {
      const fake = fakes[used++];
      if (!fake) throw new Error("no more fakes");
      return fake as unknown as ReturnType<Maker>;
    },
    count: () => used,
  };
}

/** The real worker, counted. */
function counted(): { make: Maker; count: () => number } {
  let used = 0;
  return {
    make: () => {
      used++;
      return startMathWorker();
    },
    count: () => used,
  };
}

/** Blocks the page for `ms`, as Mermaid or pagination does. */
function blockPage(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // Busy wait.
  }
}

const textOf = (el: Element | null) => el?.textContent ?? null;

describe("the worker draws formulas", () => {
  test("a formula draws through the worker", async () => {
    const build = await renderer().ready();
    const inline = await build("\\frac{a}{b}", false);
    expect(inline?.namespaceURI).toBe(MATHML_NS);
    expect(inline?.localName).toBe("math");
    expect(inline?.classList.contains("docwalk-math")).toBe(true);
    expect(inline?.querySelector("mfrac")).not.toBeNull();
    expect(inline?.hasAttribute("display")).toBe(false);
    const display = await build("\\frac{a}{b}", true);
    expect(display?.getAttribute("display")).toBe("block");
  });

  test("a formula Temml rejects is null, and the worker goes on", async () => {
    const build = await renderer().ready();
    expect(await build("\\notacommand{x}", false)).toBeNull();
    expect(await build("x+y", false)).not.toBeNull();
  });
});

describe("a formula past the deadline", () => {
  test("is source, and the next formula draws on a new worker", async () => {
    const workers = counted();
    const build = await renderer({ createWorker: workers.make, deadlineMs: 50 }).ready();
    expect(workers.count()).toBe(1);
    const started = performance.now();
    // 620 characters; about 480 ms of parse in a worker, so nine deadlines.
    expect(await build(bomb(100, 200, 99), false)).toBeNull();
    expect(performance.now() - started).toBeLessThan(450);
    const next = await build("x+y", false);
    expect(next?.localName).toBe("math");
    expect(workers.count()).toBe(2);
  });

  test("is refused at once the next time", async () => {
    const workers = counted();
    const build = await renderer({ createWorker: workers.make, deadlineMs: 50 }).ready();
    const source = bomb(100, 200, 99);
    expect(await build(source, false)).toBeNull();
    const started = performance.now();
    expect(await build(source, false)).toBeNull();
    expect(performance.now() - started).toBeLessThan(20);
    expect(workers.count()).toBe(1);
  });

  test("is remembered by its form: the same TeX as inline is a different formula", async () => {
    const hang = new FakeWorker(() => undefined);
    const next = answering();
    const { make } = factory(hang, next);
    const build = await renderer({ createWorker: make, deadlineMs: 20 }).ready();
    expect(await build("x", true)).toBeNull();
    expect(hang.terminated).toBe(true);
    expect(textOf(await build("x", false))).toBe("x");
  });

  test("the memo keeps the last 100 sources", async () => {
    const fakes = Array.from({ length: 103 }, () => new FakeWorker(() => undefined));
    const workers = factory(...fakes, answering());
    const build = await renderer({ createWorker: workers.make, deadlineMs: 2 }).ready();
    for (let i = 0; i < 101; i++) expect(await build(`x_${i}`, false)).toBeNull();
    const before = workers.count();
    // The newest is remembered: nothing is posted, no worker starts.
    expect(await build("x_100", false)).toBeNull();
    expect(workers.count()).toBe(before);
    // The oldest was dropped: it is tried again, on a new worker.
    expect(await build("x_0", false)).toBeNull();
    expect(workers.count()).toBe(before + 1);
  });

  test("a busy page does not cost a formula its result", async () => {
    // The reply comes 60 ms after the post and the page is blocked for 200 ms: when the
    // blocked page runs again both timers are due and the deadline's is first. A page that
    // was busy is not a formula that ran long, so the deadline waits once more.
    const worker = new FakeWorker((self, request) => {
      const wait = Math.max(0, self.postedAt + 60 - performance.now());
      setTimeout(() => self.say({ kind: "tree", id: request.id, tree: mi("late") }), wait);
    });
    const build = await renderer({ createWorker: factory(worker).make, deadlineMs: 50 }).ready();
    const result = build("x+y", false);
    setTimeout(() => blockPage(200), 0);
    expect(textOf(await result)).toBe("late");
    expect(worker.terminated).toBe(false);
  });

  test("a real formula survives a page that was busy for a deadline", async () => {
    const build = await renderer({ deadlineMs: 50 }).ready();
    const result = build("x+y", false);
    setTimeout(() => blockPage(200), 0);
    expect((await result)?.localName).toBe("math");
  });

  test("a second late timer is a deadline all the same", async () => {
    const worker = new FakeWorker(() => undefined);
    const build = await renderer({ createWorker: factory(worker).make, deadlineMs: 20 }).ready();
    const result = build("x", false);
    setTimeout(() => blockPage(150), 0);
    expect(await result).toBeNull();
    expect(worker.terminated).toBe(true);
  });
});

describe("a worker that cannot start", () => {
  test("leaves the renderer unavailable", async () => {
    const lost = renderer({
      createWorker: () => new Worker("/no-such-math-worker.js", { type: "module" }),
      startMs: 2000,
    });
    const started = performance.now();
    await expect(lost.ready()).rejects.toBeInstanceOf(Error);
    expect(performance.now() - started).toBeLessThan(2500);
    const throwing = renderer({
      createWorker: () => {
        throw new Error("workers are blocked");
      },
    });
    const at = performance.now();
    await expect(throwing.ready()).rejects.toBeInstanceOf(Error);
    expect(performance.now() - at).toBeLessThan(100);
  });

  test("one that never says ready is given up on", async () => {
    const silent = new FakeWorker(() => undefined, false);
    const r = renderer({ createWorker: factory(silent).make, startMs: 30 });
    await expect(r.ready()).rejects.toBeInstanceOf(Error);
    expect(silent.terminated).toBe(true);
  });

  test("a failed start does not hold the next call", async () => {
    const silent = new FakeWorker(() => undefined, false);
    const good = answering();
    const r = renderer({ createWorker: factory(silent, good).make, startMs: 30 });
    await expect(r.ready()).rejects.toBeInstanceOf(Error);
    const build = await r.ready();
    expect(textOf(await build("x", false))).toBe("x");
  });
});

describe("a worker that fails", () => {
  test("a crash fails its formula, and the next one starts a new worker", async () => {
    const crashing = new FakeWorker((worker) => worker.crash());
    const next = answering("y");
    const workers = factory(crashing, next);
    const build = await renderer({ createWorker: workers.make }).ready();
    expect(await build("a", false)).toBeNull();
    expect(crashing.terminated).toBe(true);
    expect(textOf(await build("b", false))).toBe("y");
    expect(workers.count()).toBe(2);
  });

  test("a message that cannot be read fails its formula the same way", async () => {
    const odd = new FakeWorker((worker) => worker.dispatchEvent(new Event("messageerror")));
    const build = await renderer({ createWorker: factory(odd, answering()).make }).ready();
    expect(await build("a", false)).toBeNull();
    expect(odd.terminated).toBe(true);
    expect(textOf(await build("b", false))).toBe("x");
  });

  test("a reply for another request is ignored", async () => {
    const worker = new FakeWorker((self, request) => {
      self.say({ kind: "tree", id: request.id + 1, tree: mi("wrong") });
      self.say({ kind: "tree", id: request.id, tree: mi("right") });
    });
    const build = await renderer({ createWorker: factory(worker).make }).ready();
    expect(textOf(await build("a", false))).toBe("right");
  });

  test("anything that is not a reply is ignored", async () => {
    const worker = new FakeWorker((self, request) => {
      for (const junk of [
        null,
        7,
        "tree",
        { kind: "other" },
        { kind: "tree" },
        { kind: "tree", id: "1" },
      ]) {
        self.say(junk as never);
      }
      self.say({ kind: "tree", id: request.id, tree: mi("right") });
    });
    const build = await renderer({ createWorker: factory(worker).make }).ready();
    expect(textOf(await build("a", false))).toBe("right");
  });

  test("a tree that is not allowed is a failed formula, never a throw", async () => {
    const hostile = new FakeWorker((self, request) =>
      self.say({ kind: "tree", id: request.id, tree: { name: "div" } as never }),
    );
    const build = await renderer({ createWorker: factory(hostile).make }).ready();
    expect(await build("a", false)).toBeNull();
  });
});

describe("formulas take turns", () => {
  test("two builds started together each get their own tree, one in flight at a time", async () => {
    let inFlight = 0;
    let most = 0;
    const worker = new FakeWorker((self, request) => {
      setTimeout(() => {
        inFlight--;
        self.say({ kind: "tree", id: request.id, tree: mi(request.tex) });
      }, 5);
    });
    const post = worker.postMessage.bind(worker);
    worker.postMessage = (request) => {
      inFlight++;
      most = Math.max(most, inFlight);
      post(request);
    };
    const build = await renderer({ createWorker: factory(worker).make }).ready();
    const [first, second] = await Promise.all([build("one", false), build("two", false)]);
    expect([textOf(first), textOf(second)]).toEqual(["one", "two"]);
    expect(most).toBe(1);
    const [a, b] = worker.posts;
    expect(a?.id).not.toBe(b?.id);
  });

  test("two ready() calls share one worker", async () => {
    const workers = counted();
    const r = renderer({ createWorker: workers.make });
    await Promise.all([r.ready(), r.ready()]);
    expect(workers.count()).toBe(1);
  });

  test("dispose stops the worker and a formula in flight is null", async () => {
    const worker = new FakeWorker(() => undefined);
    const r = renderer({ createWorker: factory(worker).make });
    const build = await r.ready();
    const pending = build("x", false);
    r.dispose();
    expect(await pending).toBeNull();
    expect(worker.terminated).toBe(true);
  });
});
