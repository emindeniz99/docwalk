import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { isPersistent, requestPersistence, storageUse } from "./storage";

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("asking the browser to keep the workspace (decision 91)", () => {
  test("asks and reports the answer", async () => {
    vi.spyOn(navigator.storage, "persisted").mockResolvedValue(false);
    const persist = vi.spyOn(navigator.storage, "persist").mockResolvedValue(true);
    expect(await requestPersistence()).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  test("does not ask for what is already granted", async () => {
    vi.spyOn(navigator.storage, "persisted").mockResolvedValue(true);
    const persist = vi.spyOn(navigator.storage, "persist").mockResolvedValue(true);
    expect(await requestPersistence()).toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  test("a refusal is remembered for seven days, then asked again", async () => {
    // Firefox shows a prompt for every request, so a refused user must not meet it on every visit.
    vi.spyOn(navigator.storage, "persisted").mockResolvedValue(false);
    const persist = vi.spyOn(navigator.storage, "persist").mockResolvedValue(false);
    const start = 1_000_000_000_000;
    expect(await requestPersistence(start)).toBe(false);
    expect(await requestPersistence(start + DAY)).toBe(false);
    expect(await requestPersistence(start + 6 * DAY)).toBe(false);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(await requestPersistence(start + 8 * DAY)).toBe(false);
    expect(persist).toHaveBeenCalledTimes(2);
  });

  test("a browser that throws answers unknown, never an error", async () => {
    vi.spyOn(navigator.storage, "persisted").mockRejectedValue(new Error("no"));
    vi.spyOn(navigator.storage, "persist").mockRejectedValue(new Error("no"));
    expect(await isPersistent()).toBeNull();
    expect(await requestPersistence()).toBeNull();
  });
});

describe("how much of the browser's storage is used", () => {
  test("reads usage and quota", async () => {
    vi.spyOn(navigator.storage, "estimate").mockResolvedValue({ usage: 5, quota: 10 });
    expect(await storageUse()).toEqual({ used: 5, quota: 10 });
  });

  test("is unknown when the browser gives no quota", async () => {
    vi.spyOn(navigator.storage, "estimate").mockResolvedValue({ usage: 5 });
    expect(await storageUse()).toBeNull();
  });
});
