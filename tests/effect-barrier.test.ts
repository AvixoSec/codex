import { expect, test } from "vitest";
import { EffectBarrier } from "../src/core/effect-barrier.js";

test("an empty or repeatedly settled barrier resolves without leaking handlers", async () => {
  const barrier = new EffectBarrier();
  await barrier.settle();
  const promise = Promise.resolve("value");
  expect(barrier.track(promise)).toBe(promise);
  await barrier.settle();
  await barrier.settle();
});

test("track preserves fulfillment and rejection while settle absorbs failures", async () => {
  const barrier = new EffectBarrier();
  await expect(barrier.track(Promise.resolve(42))).resolves.toBe(42);
  const error = new Error("private failure");
  const rejection = barrier.track(Promise.reject(error));
  await expect(rejection).rejects.toBe(error);
  await expect(barrier.settle()).resolves.toBeUndefined();
});

test("settle waits for effects registered while settlement is in progress", async () => {
  const barrier = new EffectBarrier();
  let first!: () => void;
  let second!: () => void;
  barrier.track(new Promise<void>((resolve) => { first = resolve; }));
  let settled = false;
  const wait = barrier.settle().then(() => { settled = true; });
  barrier.track(new Promise<void>((resolve) => { second = resolve; }));
  first();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(settled).toBe(false);
  second();
  await wait;
  expect(settled).toBe(true);
});
