import { describe, it, expect, vi } from "vitest";
import { debounce, formatTime } from "../src/lib/watch.js";

describe("debounce", () => {
  it("collapses rapid calls into a single invocation", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 300);

    debounced();
    debounced();
    debounced();
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(299);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("restarts the timer on each call", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 300);

    debounced();
    vi.advanceTimersByTime(200);
    debounced();
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("passes through the latest arguments", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 300);

    debounced("first");
    debounced("second");
    vi.advanceTimersByTime(300);

    expect(fn).toHaveBeenCalledWith("second");
    vi.useRealTimers();
  });
});

describe("formatTime", () => {
  it("formats as zero-padded HH:MM:SS", () => {
    expect(formatTime(new Date(2026, 0, 1, 3, 5, 9))).toBe("03:05:09");
    expect(formatTime(new Date(2026, 0, 1, 23, 59, 0))).toBe("23:59:00");
  });
});
