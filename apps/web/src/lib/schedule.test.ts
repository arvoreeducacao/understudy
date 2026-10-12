import assert from "node:assert/strict";
import { test } from "node:test";
import { describeSchedule, parseCron, toCron } from "./schedule";

test("common schedules round trip", () => {
  for (const cron of ["0 8 * * *", "30 9 * * 1-5", "0 8 * * 1", "15 7 1 * *", ""]) {
    assert.equal(toCron(parseCron(cron)), cron);
  }
});

test("anything else is kept as a custom schedule", () => {
  const schedule = parseCron("*/15 * * * *");
  assert.equal(schedule.mode, "custom");
  assert.equal(toCron(schedule), "*/15 * * * *");
});

test("schedules read as plain words", () => {
  assert.equal(describeSchedule(null), "Only when I ask");
  assert.equal(describeSchedule("0 9 * * 1-5"), "Every weekday at 09:00");
  assert.equal(describeSchedule("30 8 * * 1"), "Every Monday at 08:30");
  assert.equal(describeSchedule("0 7 15 * *"), "Day 15 of every month at 07:00");
  assert.equal(describeSchedule("*/15 * * * *"), "Custom schedule (*/15 * * * *)");
});
