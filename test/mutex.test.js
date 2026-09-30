import test from 'node:test';
import assert from 'node:assert/strict';
import { Mutex } from '../src/daemon/mutex.js';

test('runs tasks one at a time in order and survives failures', async () => {
  const mutex = new Mutex();
  const order = [];
  let active = 0;
  let maxActive = 0;
  const task = (name, ms, fail = false) => mutex.run(async () => {
    active += 1; maxActive = Math.max(maxActive, active);
    order.push(`start ${name}`);
    await new Promise((resolve) => setTimeout(resolve, ms));
    order.push(`end ${name}`);
    active -= 1;
    if (fail) throw new Error(name);
    return name;
  });
  assert.equal(mutex.busy, false);
  const results = await Promise.allSettled([task('a', 20), task('b', 5, true), task('c', 1)]);
  assert.equal(maxActive, 1);
  assert.deepEqual(order, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[2].value, 'c');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mutex.busy, false);
});
