"use client";

import Link from "next/link";
import { useState } from "react";
import {
  BarChart3,
  Boxes,
  CheckCircle2,
  ChevronDown,
  FileCheck2,
  Plus,
  XCircle,
} from "lucide-react";
import { SectionTabs } from "@/components/section-tabs";
import {
  Badge,
  Button,
  Card,
  MetricCard,
  PageHeader,
  Progress,
  SectionTitle,
} from "@/components/ui";

const runs = [
  [
    "run_01H8Z3",
    "PR #142 – OAuth authentication",
    "documentation",
    12,
    11,
    1,
    "0.92",
  ],
  [
    "run_01H7Y1",
    "Release v1.2.0 notes",
    "release_notes",
    10,
    9,
    1,
    "0.88",
  ],
  [
    "run_01H6K9",
    "Redis caching guide",
    "documentation",
    14,
    14,
    0,
    "0.96",
  ],
  [
    "run_01HSQ8",
    "Support response evaluation",
    "support",
    16,
    13,
    3,
    "0.84",
  ],
  [
    "run_01H4J2",
    "API reference update",
    "api_reference",
    12,
    11,
    1,
    "0.90",
  ],
];

const trendRanges = ["Last 7 days", "Last 14 days", "Last 30 days"] as const;
type TrendRange = (typeof trendRanges)[number];

const trendSeries: Record<TrendRange, { dates: string[]; scores: number[] }> = {
  "Last 7 days": {
    dates: ["Aug 30", "Aug 31", "Sep 1", "Sep 2", "Sep 3", "Sep 4", "Sep 5"],
    scores: [72, 74, 79, 83, 91, 94, 100],
  },
  "Last 14 days": {
    dates: ["Aug 23", "Aug 24", "Aug 25", "Aug 26", "Aug 27", "Aug 28", "Aug 29", "Aug 30", "Aug 31", "Sep 1", "Sep 2", "Sep 3", "Sep 4", "Sep 5"],
    scores: [48, 53, 50, 58, 63, 62, 69, 87, 74, 76, 82, 91, 94, 100],
  },
  "Last 30 days": {
    dates: Array.from({ length: 30 }, (_, index) => index < 26 ? `Aug ${7 + index}` : `Sep ${index - 25}`),
    scores: [41, 44, 43, 48, 46, 51, 49, 54, 57, 55, 59, 61, 60, 65, 63, 68, 70, 69, 73, 72, 76, 78, 77, 82, 85, 87, 90, 94, 96, 100],
  },
};

function EvaluationScoreTrend() {
  const [range, setRange] = useState<TrendRange>("Last 14 days");
  const series = trendSeries[range];
  const plotLeft = 40;
  const plotRight = 740;
  const plotTop = 42;
  const plotBottom = 184;
  const points = series.scores.map((score, index) => {
    const x = plotLeft + (index * (plotRight - plotLeft)) / (series.scores.length - 1);
    const y = plotBottom - (score / 100) * (plotBottom - plotTop);
    return { x, y, score, date: series.dates[index] };
  });
  const trendLine = points.map(({ x, y }) => `${x},${y}`).join(" ");
  const trendArea = `${plotLeft},${plotBottom} ${trendLine} ${plotRight},${plotBottom}`;
  const highlight = points[Math.round((points.length - 1) * 0.62)];
  const tooltipX = Math.min(Math.max(highlight.x - 44, plotLeft), plotRight - 88);
  const labelIndexes = Array.from(
    new Set(Array.from({ length: 7 }, (_, index) => Math.round((index * (points.length - 1)) / 6))),
  );

  return (
    <Card className="h-[286px] min-w-0 overflow-hidden xl:col-span-2">
      <SectionTitle
        icon={<FileCheck2 aria-hidden="true" className="h-4 w-4" />}
        title="Evaluation score trend"
        subtitle="Average evaluation score over time"
        action={
          <label className="relative block">
            <span className="sr-only">Evaluation score trend date range</span>
            <select
              value={range}
              onChange={(event) => setRange(event.target.value as TrendRange)}
              className="h-8 appearance-none rounded-md border border-border bg-surface py-0 pl-3 pr-9 text-[11px] font-medium text-foreground-secondary outline-none hover:bg-surface-subtle focus:border-ring focus:ring-2 focus:ring-ring/20">
              {trendRanges.map((option) => <option key={option}>{option}</option>)}
            </select>
            <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground-muted" />
          </label>
        }
      />

      <div className="px-4 pb-3 pt-1">
        <svg
          viewBox="0 0 780 218"
          role="img"
          aria-label={`Evaluation scores for ${range.toLowerCase()}, rising from ${series.scores[0]} percent to ${series.scores.at(-1)} percent`}
          className="h-[218px] w-full">
          <defs>
            <linearGradient id="evaluation-score-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#5B7CFA" stopOpacity=".24" />
              <stop offset="1" stopColor="#5B7CFA" stopOpacity=".025" />
            </linearGradient>
          </defs>

          {[42, 70.4, 98.8, 127.2, 155.6, 184].map((y, index) => (
            <g key={y}>
              <line
                x1="40"
                y1={y}
                x2={plotRight}
                y2={y}
                stroke="currentColor"
                className="text-slate-200 dark:text-slate-800"
                strokeWidth="1"
              />
              <text
                x="27"
                y={y + 3}
                textAnchor="end"
                className="fill-slate-500 text-[9px] dark:fill-slate-400">
                {100 - index * 20}
              </text>
            </g>
          ))}

          {labelIndexes.map((index) => (
            <line
              key={index}
              x1={points[index].x}
              y1={plotTop}
              x2={points[index].x}
              y2={plotBottom}
              stroke="currentColor"
              className="text-slate-100 dark:text-slate-800/70"
              strokeWidth="1"
            />
          ))}

          <polygon points={trendArea} fill="url(#evaluation-score-area)" />
          <polyline
            points={trendLine}
            fill="none"
            stroke="#2F62F5"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          <line
            x1={highlight.x}
            y1={plotTop}
            x2={highlight.x}
            y2={plotBottom}
            stroke="#C9D5F6"
            strokeDasharray="3 3"
          />
          <circle cx={highlight.x} cy={highlight.y} r="6" fill="#2F62F5" stroke="white" strokeWidth="3" />

          <g transform={`translate(${tooltipX} 0)`}>
            <rect
              width="88"
              height="40"
              rx="6"
              className="fill-white stroke-slate-200 dark:fill-slate-950 dark:stroke-slate-700"
              filter="drop-shadow(0 2px 4px rgba(15,23,42,.08))"
            />
            <text x="12" y="16" className="fill-slate-500 text-[9px] dark:fill-slate-400">
              {highlight.date}, 2026
            </text>
            <text x="12" y="30" className="fill-slate-900 text-[10px] font-semibold dark:fill-slate-100">
              Score: {highlight.score}%
            </text>
          </g>

          {labelIndexes.map((index) => (
            <text
              key={index}
              x={points[index].x}
              y="207"
              textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}
              className="fill-slate-500 text-[9px] dark:fill-slate-400">
              {points[index].date}
            </text>
          ))}
        </svg>
      </div>
    </Card>
  );
}

function EvaluationScoresByMetric() {
  return (
    <Card className="h-[286px] min-w-0">
      <SectionTitle
        icon={<FileCheck2 aria-hidden="true" className="h-4 w-4" />}
        title="Evaluation scores by metric"
        subtitle="Average score per evaluation metric"
      />
      <div className="flex h-[220px] flex-col justify-around px-4 pb-4 pt-3">
        {[
          ["Correctness", 94],
          ["Completeness", 91],
          ["Grounding", 89],
          ["Consistency", 92],
          ["Documentation quality", 90],
        ].map(([name, value], index) => (
          <div
            key={name as string}
            className="grid grid-cols-[108px_minmax(0,1fr)_30px] items-center gap-3 text-[11px]">
            <span className="truncate text-foreground-secondary">{name}</span>
            <Progress
              value={value as number}
              tone={
                index === 1
                  ? "blue"
                  : index === 2
                    ? "violet"
                    : index === 3
                      ? "amber"
                      : index === 4
                        ? "blue"
                        : "green"
              }
            />
            <span className="font-medium text-foreground">{value}%</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

export default function Page() {
  return (
    <>
      <PageHeader
        title="Evaluations"
        subtitle="Measure and improve the quality of Draftly's documentation outputs using the Strands Eval SDK."
        actions={
          <Button primary>
            <Plus className="h-4 w-4" />
            Run evaluation
          </Button>
        }
      />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard
          label="Average score"
          value="92%"
          sub="Across all runs"
          trend="6%"
          tone="green"
          icon={<BarChart3 className="h-5 w-5" />}
        />
        <MetricCard
          label="Total runs"
          value="48"
          sub="In the last 14 days"
          trend="20%"
          icon={<Boxes className="h-5 w-5" />}
        />
        <MetricCard
          label="Passed"
          value="42"
          sub="88% pass rate"
          tone="green"
          icon={<CheckCircle2 className="h-5 w-5" />}
        />
        <MetricCard
          label="Failed"
          value="6"
          sub="12% fail rate"
          tone="rose"
          icon={<XCircle className="h-5 w-5" />}
        />
        <MetricCard
          label="Test cases"
          value="128"
          sub="Across 6 datasets"
          trend="8%"
          tone="violet"
          icon={<FileCheck2 className="h-5 w-5" />}
        />
      </div>

      <div className="mt-4">
        <SectionTabs section="evaluations" />
      </div>

      <div className="mt-4 grid min-w-0 gap-4 xl:grid-cols-3">
        <EvaluationScoreTrend />
        <EvaluationScoresByMetric />
      </div>

      <Card className="mt-4 overflow-hidden">
        <SectionTitle title="Recent evaluation runs" />
        <div className="overflow-x-auto p-4">
          <table className="min-w-full text-left text-xs">
            <thead className="text-slate-500">
              <tr>
                {[
                  "Run ID",
                  "Name",
                  "Dataset",
                  "Test cases",
                  "Passed",
                  "Failed",
                  "Average score",
                  "Status",
                ].map((heading) => (
                  <th className="px-3 py-2" key={heading}>
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {runs.map((run) => (
                <tr key={run[0] as string}>
                  <td className="px-3 py-3 text-blue-600">
                    <Link href={`/evaluations/runs/${run[0]}`}>{run[0]}</Link>
                  </td>
                  <td className="px-3 py-3 font-medium">{run[1]}</td>
                  <td className="px-3 py-3">{run[2]}</td>
                  <td className="px-3 py-3">{run[3]}</td>
                  <td className="px-3 py-3 text-emerald-600">{run[4]}</td>
                  <td className="px-3 py-3 text-rose-600">{run[5]}</td>
                  <td className="px-3 py-3">{run[6]}</td>
                  <td className="px-3 py-3">
                    <Badge tone="green">Completed</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
