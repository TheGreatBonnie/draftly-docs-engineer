export const dateRanges = ["Today", "Last 7 days", "Last 14 days", "Last 30 days"] as const;
export type ChartRange = (typeof dateRanges)[number];

export type ActivityPoint = {
  date: string;
  created: number;
  updated: number;
  reviewed: number;
  published: number;
};

const referenceDates = [
  "Aug 18", "Aug 19", "Aug 21", "Aug 22", "Aug 24", "Aug 25", "Aug 27",
  "Aug 28", "Aug 30", "Aug 31", "Sep 2", "Sep 3", "Sep 4", "Sep 5",
];
const referenceTotals = [18, 19, 21, 26, 32, 22, 28, 31, 21, 26, 24, 27, 35, 27];

const activity14 = referenceDates.map((date, index): ActivityPoint => {
  const total = referenceTotals[index];
  const created = Math.round(total * 0.44);
  const updated = Math.round(total * 0.22);
  const reviewed = Math.round(total * 0.17);
  return { date, created, updated, reviewed, published: total - created - updated - reviewed };
});

const earlierDates = [
  "Aug 2", "Aug 3", "Aug 4", "Aug 5", "Aug 6", "Aug 7", "Aug 8", "Aug 9",
  "Aug 10", "Aug 11", "Aug 12", "Aug 13", "Aug 14", "Aug 15", "Aug 16", "Aug 17",
];
const earlierTotals = [16, 20, 19, 23, 25, 18, 24, 29, 22, 27, 20, 25, 23, 28, 26, 30];
const earlierActivity = earlierDates.map((date, index): ActivityPoint => {
  const total = earlierTotals[index];
  const created = Math.round(total * 0.44);
  const updated = Math.round(total * 0.22);
  const reviewed = Math.round(total * 0.17);
  return { date, created, updated, reviewed, published: total - created - updated - reviewed };
});

const activitySeries: Record<ChartRange, ActivityPoint[]> = {
  Today: activity14.slice(-1),
  "Last 7 days": activity14.slice(-7),
  "Last 14 days": activity14,
  "Last 30 days": [...earlierActivity, ...activity14],
};

export function chartDataForRange(range: ChartRange): ActivityPoint[] {
  return activitySeries[range];
}
