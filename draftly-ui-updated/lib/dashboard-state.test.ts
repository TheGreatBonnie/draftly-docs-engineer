import test from "node:test";
import assert from "node:assert/strict";
import { chartDataForRange, dateRanges, type ChartRange } from "./dashboard-state.ts";

test("returns the full mock activity series for the 14-day range", () => {
  const series = chartDataForRange("Last 14 days");

  assert.equal(series.length, 14);
  assert.deepEqual(series[0], {
    date: "Aug 18",
    created: 8,
    updated: 4,
    reviewed: 3,
    published: 3,
  });
  assert.ok(
    series.every(
      ({ created, updated, reviewed, published }) =>
        created + updated + reviewed + published <= 40,
    ),
  );
});

test("returns shorter mock activity series for compact ranges", () => {
  assert.equal(chartDataForRange("Today").length, 1);
  assert.equal(chartDataForRange("Last 7 days").length, 7);
  assert.equal(chartDataForRange("Last 30 days").length, 30);
});

test("exposes the supported date range labels", () => {
  assert.deepEqual(dateRanges, ["Today", "Last 7 days", "Last 14 days", "Last 30 days"] satisfies ChartRange[]);
});
