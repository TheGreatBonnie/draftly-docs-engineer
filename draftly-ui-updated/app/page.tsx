"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bot,
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  Database,
  FileCheck2,
  FileText,
  GitPullRequest,
  Plus,
  SearchCheck,
  ServerCog,
  Sparkles,
  Star,
  Workflow,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  IconTile,
  MetricCard,
  PageHeader,
  Progress,
  SectionTitle,
  TinyLink,
} from "@/components/ui";
import {
  chartDataForRange,
  dateRanges,
  type ChartRange,
} from "@/lib/dashboard-state";

const statusItems = [
  ["Published", "214", "67%", "bg-emerald-500"],
  ["In review", "48", "15%", "bg-blue-500"],
  ["Draft", "32", "10%", "bg-amber-400"],
  ["Needs attention", "16", "5%", "bg-rose-500"],
  ["Archived", "8", "3%", "bg-slate-400"],
];
const workflowItems = [
  [
    "PR Documentation",
    "Authly",
    "Running",
    "12 min ago",
    "/workflows/pr-documentation",
  ],
  [
    "Release Notes",
    "Authly",
    "Running",
    "28 min ago",
    "/workflows/release-notes",
  ],
  [
    "Support Intelligence",
    "Authly",
    "Running",
    "1 hour ago",
    "/workflows/support-intelligence",
  ],
  [
    "Scheduled Audit",
    "All repositories",
    "Scheduled",
    "In 6 hours",
    "/workflows/scheduled-audit",
  ],
];
const changeItems = [
  [
    "Update OAuth authentication guide",
    "docs/authentication.md • PR #142",
    "12 min ago",
    "In review",
    "blue",
  ],
  [
    "Add Redis caching guide",
    "docs/redis/caching.md • Issue #87",
    "45 min ago",
    "In review",
    "blue",
  ],
  [
    "API rate limits documentation",
    "docs/api/rate-limits.md • PR #138",
    "1 hour ago",
    "Needs changes",
    "amber",
  ],
  [
    "Deployment guide for v1.2.0",
    "docs/deployment.md • Release v1.2.0",
    "3 hours ago",
    "Approved",
    "green",
  ],
  [
    "Legacy auth migration guide",
    "docs/migration/legacy.md • Issue #65",
    "5 hours ago",
    "Published",
    "green",
  ],
] as const;
const attentionItems = [
  ["12 reviews pending", "3 high risk", "/reviews/pending", "rose", FileCheck2],
  [
    "3 failed evaluations",
    "Needs investigation",
    "/evaluations/runs",
    "amber",
    CircleAlert,
  ],
  [
    "1 data source issue",
    "Discord connection error",
    "/integrations/discord",
    "violet",
    Database,
  ],
  [
    "2 stale documentation areas",
    "No updates in 30+ days",
    "/documentation/outdated",
    "blue",
    FileText,
  ],
] as const;

function RangeMenu({
  value,
  options,
  onChange,
  label,
  calendar = false,
  compact = false,
}: {
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  label: string;
  calendar?: boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node))
        setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`inline-flex max-w-full items-center whitespace-nowrap rounded-lg border border-border bg-surface font-medium text-foreground-secondary hover:bg-surface-subtle ${compact ? "h-8 gap-2 px-3 text-[11px]" : "h-10 gap-3 px-3 text-sm"}`}>
        {calendar && <CalendarDays aria-hidden="true" className="h-4 w-4" />}
        <span className="truncate">{value}</span>
        <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div
          role="menu"
          aria-label={label}
          className="absolute right-0 top-11 z-20 min-w-[190px] rounded-xl border border-border bg-surface p-1 shadow-xl">
          {options.map((option) => (
            <button
              type="button"
              role="menuitem"
              key={option}
              onClick={() => {
                onChange(option);
                setOpen(false);
              }}
              className={
                "block w-full rounded-lg px-3 py-2 text-left text-sm " +
                (option === value
                  ? "bg-brand-soft font-medium text-brand"
                  : "text-foreground-secondary hover:bg-surface-subtle")
              }>
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
function AttentionPanel() {
  return (
    <Card className="border-brand/20 bg-gradient-to-br from-brand-soft/70 via-surface to-surface p-1">
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <IconTile size="sm" tone="rose">
              <AlertTriangle aria-hidden="true" className="h-4 w-4" />
            </IconTile>
            <h2 className="font-semibold">Needs your attention</h2>
          </div>
          <p className="mt-2 max-w-2xl text-sm text-foreground-muted">
            Resolve the highest-impact documentation issues before they become
            stale or block a release.
          </p>
        </div>
        <Link
          href="/reviews/needs-attention"
          className="inline-flex shrink-0 items-center gap-1 text-sm font-semibold text-brand hover:underline">
          Review all <ArrowRight aria-hidden="true" className="h-4 w-4" />
        </Link>
      </div>
      <div className="grid gap-2 border-t border-border/70 p-3 sm:grid-cols-2 xl:grid-cols-4">
        {attentionItems.map(([title, subtitle, href, tone, Icon]) => (
          <Link
            key={title}
            href={href}
            className="group flex items-center gap-3 rounded-xl border border-border/70 bg-surface/80 p-3 transition hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-sm">
            <IconTile size="sm" tone={tone}>
              <Icon aria-hidden="true" className="h-4 w-4" />
            </IconTile>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">
                {title}
              </span>
              <span className="mt-0.5 block truncate text-xs text-foreground-muted">
                {subtitle}
              </span>
            </span>
            <ArrowRight
              aria-hidden="true"
              className="h-4 w-4 shrink-0 text-foreground-muted transition group-hover:translate-x-0.5 group-hover:text-brand"
            />
          </Link>
        ))}
      </div>
    </Card>
  );
}

function ActivityChart({
  range,
  onRangeChange,
}: {
  range: ChartRange;
  onRangeChange: (range: ChartRange) => void;
}) {
  const values = chartDataForRange(range);
  const axisLabels =
    range === "Last 14 days"
      ? ["Aug 18", "Aug 21", "Aug 24", "Aug 27", "Aug 30", "Sep 2", "Sep 5"]
      : range === "Today"
        ? ["Now"]
        : Array.from({ length: Math.min(7, values.length) }, (_, index) => {
            const pointIndex = Math.round((index * (values.length - 1)) / (Math.min(7, values.length) - 1));
            return values[pointIndex]?.date;
          });
  return (
    <Card className="h-[356px]">
      <div className="flex items-start justify-between gap-3 px-4 pt-4">
        <div className="flex min-w-0 gap-3">
          <IconTile size="sm">
            <FileText aria-hidden="true" className="h-4 w-4" />
          </IconTile>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">
              Documentation activity
            </h3>
            <p className="mt-0.5 truncate text-[11px] text-foreground-muted">
              AI-generated and updated documentation over time
            </p>
          </div>
        </div>
        <div className="shrink-0">
          <RangeMenu
            compact
            label="Choose activity range"
            value={range}
            options={dateRanges}
            onChange={(value) => onRangeChange(value as ChartRange)}
          />
        </div>
      </div>
      <figure className="px-4 pb-4 pt-3">
        <figcaption className="mb-3 flex flex-wrap justify-end gap-x-5 gap-y-1 text-[10px] text-foreground-muted">
          {[
            ["Created", "bg-blue-600"],
            ["Updated", "bg-indigo-400"],
            ["Reviewed", "bg-emerald-400"],
            ["Published", "bg-blue-200"],
          ].map(([label, color]) => (
            <span key={label} className="inline-flex items-center gap-1">
              <i className={`h-2 w-2 rounded-full ${color}`} />
              {label}
            </span>
          ))}
        </figcaption>
        <div className="grid grid-cols-[24px_1fr] gap-2">
          <div className="flex h-52 flex-col justify-between text-right text-[10px] leading-none text-foreground-muted">
            {[40, 30, 20, 10, 0].map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>
          <div className="min-w-0">
            <div className="relative h-52">
              <div aria-hidden="true" className="absolute inset-0 flex flex-col justify-between">
                {[40, 30, 20, 10, 0].map((line) => (
                  <span key={line} className="w-full border-t border-border" />
                ))}
              </div>
              <div className="absolute inset-0 z-10 flex items-end justify-between gap-1.5 px-2">
                {values.map((value, index) => {
                  const total = value.created + value.updated + value.reviewed + value.published;
                  return (
                    <div
                      key={range + value.date + index}
                      className="group relative flex h-full max-w-7 flex-1 items-end">
                      <button
                        type="button"
                        aria-label={`${total} documentation changes on ${value.date}`}
                        className="relative flex w-full flex-col-reverse overflow-hidden rounded-t-sm transition hover:brightness-110 focus-visible:ring-2 focus-visible:ring-ring"
                        style={{ height: `${Math.max(5, (total / 40) * 100)}%` }}>
                        <span className="w-full bg-blue-600" style={{ height: `${(value.created / total) * 100}%` }} />
                        <span className="w-full bg-indigo-400" style={{ height: `${(value.updated / total) * 100}%` }} />
                        <span className="w-full bg-emerald-400" style={{ height: `${(value.reviewed / total) * 100}%` }} />
                        <span className="w-full bg-blue-200" style={{ height: `${(value.published / total) * 100}%` }} />
                        <span className="pointer-events-none absolute left-1/2 top-1 hidden -translate-x-1/2 rounded-md bg-foreground px-2 py-1 text-[10px] text-background group-hover:block">
                          {total}
                        </span>
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
            <div
              className="mt-2 grid text-[10px] text-foreground-muted"
              style={{ gridTemplateColumns: `repeat(${axisLabels.length}, minmax(0, 1fr))` }}>
              {axisLabels.map((label, index) => (
                <span
                  key={label + index}
                  className={index === 0 ? "text-left" : index === axisLabels.length - 1 ? "text-right" : "text-center"}>
                  {label}
                </span>
              ))}
            </div>
          </div>
        </div>
      </figure>
    </Card>
  );
}

function IntegrationCardIllustration() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 132 188"
      className="pointer-events-none absolute inset-y-0 right-0 h-full w-[205px]"
      fill="none">
      <defs>
        <linearGradient id="integration-tile" x1="57" y1="95" x2="124" y2="181">
          <stop stopColor="#B9ADFF" stopOpacity=".78" />
          <stop offset="1" stopColor="#7E6BF4" stopOpacity=".42" />
        </linearGradient>
        <linearGradient id="integration-page" x1="29" y1="120" x2="90" y2="188">
          <stop stopColor="#FFFFFF" />
          <stop offset="1" stopColor="#F4F3FF" />
        </linearGradient>
      </defs>

      <path d="m103 28 2.7 6.3 6.3 2.7-6.3 2.7-2.7 6.3-2.7-6.3-6.3-2.7 6.3-2.7 2.7-6.3Z" fill="#6E46ED" />
      <path d="m89 47 1.4 3.3 3.3 1.4-3.3 1.4-1.4 3.3-1.4-3.3-3.3-1.4 3.3-1.4L89 47Z" fill="#9A7BFF" />

      <rect x="56" y="95" width="69" height="98" rx="8" fill="url(#integration-tile)" />
      <rect x="66" y="106" width="49" height="9" rx="4.5" fill="#8172F5" fillOpacity=".32" />
      <rect x="66" y="121" width="39" height="6" rx="3" fill="#8172F5" fillOpacity=".2" />

      <path
        d="M43 116a7 7 0 0 1 7-7h48a7 7 0 0 1 7 7v79H43v-79Z"
        fill="#D7D1FF"
        fillOpacity=".88"
        stroke="#9A8AF7"
        strokeWidth="1.25"
      />
      <rect x="53" y="122" width="34" height="5" rx="2.5" fill="#9283F6" fillOpacity=".48" />

      <path
        d="M29 127a7 7 0 0 1 7-7h49a7 7 0 0 1 7 7v68H29v-68Z"
        fill="url(#integration-page)"
        stroke="#7764F2"
        strokeWidth="1.5"
      />
      <rect x="39" y="137" width="34" height="5" rx="2.5" fill="#6653EE" />
      <rect x="39" y="150" width="43" height="5" rx="2.5" fill="#8A79F7" />
      <rect x="39" y="163" width="29" height="5" rx="2.5" fill="#A69AF9" />
    </svg>
  );
}

export default function Page() {
  const [range, setRange] = useState<ChartRange>("Last 14 days");
  const [dateRange, setDateRange] = useState("Aug 18, 2026 – Sep 5, 2026");
  return (
    <>
      <PageHeader
        title="Good morning, Bonnie 👋"
        subtitle="Your documentation is in good shape. Here’s the work that needs your attention first."
        actions={
          <div className="flex w-full flex-wrap gap-2 sm:w-auto">
            <RangeMenu
              calendar
              label="Choose dashboard date range"
              value={dateRange}
              options={[
                "Aug 18, 2026 – Sep 5, 2026",
                "Aug 25, 2026 – Sep 5, 2026",
                "Sep 1, 2026 – Sep 5, 2026",
              ]}
              onChange={setDateRange}
            />
            <Link
              href="/workflows/new"
              className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-lg border border-transparent bg-brand px-4 text-sm font-medium text-brand-foreground hover:brightness-110 sm:flex-none">
              <Plus aria-hidden="true" className="h-4 w-4" />
              New workflow
            </Link>
          </div>
        }
      />
      <div className="space-y-4">
        <AttentionPanel />
        <section
          aria-label="Workspace summary"
          className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Documentation"
            value="318"
            sub="Total documents"
            trend="12%"
            icon={<FileText aria-hidden="true" className="h-5 w-5" />}
          />
          <MetricCard
            label="Active workflows"
            value="6"
            sub="3 running • 3 scheduled"
            trend="2"
            tone="violet"
            icon={<Activity aria-hidden="true" className="h-5 w-5" />}
          />
          <MetricCard
            label="Review queue"
            value="12"
            sub="Pending human review"
            tone="green"
            icon={<CheckCircle2 aria-hidden="true" className="h-5 w-5" />}
          />
          <MetricCard
            label="Avg. evaluation score"
            value="92%"
            sub="Across all runs"
            trend="4%"
            tone="amber"
            icon={<Star aria-hidden="true" className="h-5 w-5" />}
          />
        </section>
        <div className="grid gap-4 xl:grid-cols-[1.55fr_.95fr]">
          <div className="space-y-4">
            <ActivityChart range={range} onRangeChange={setRange} />
            <Card>
              <SectionTitle
                icon={<Activity aria-hidden="true" className="h-4 w-4" />}
                title="System pulse"
                action={<Badge tone="green">● All systems operational</Badge>}
              />
              <div className="grid gap-2 p-4 sm:grid-cols-2 md:grid-cols-4">
                {[
                  [Bot, "Agents", "4/4 online"],
                  [Database, "Data sources", "3/3 connected"],
                  [SearchCheck, "Evaluations", "Running"],
                  [ServerCog, "Scheduler", "Healthy"],
                ].map(([Icon, label, value]) => (
                  <div
                    key={String(label)}
                    className="rounded-xl border border-border p-3">
                    <Icon aria-hidden="true" className="h-4 w-4 text-brand" />
                    <div className="mt-2 text-sm font-medium">
                      {String(label)}
                    </div>
                    <div className="mt-1 text-xs text-success">
                      ● {String(value)}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
            <Card>
              <SectionTitle
                icon={<Sparkles aria-hidden="true" className="h-4 w-4" />}
                title="Recent documentation changes"
                action={
                  <TinyLink href="/activity/document-changes">
                    View all
                  </TinyLink>
                }
              />
              <div className="divide-y divide-border px-4 pb-2">
                {changeItems.map(([title, detail, time, status, tone]) => (
                  <Link
                    href="/reviews"
                    key={title}
                    className="flex items-center gap-3 py-3">
                    <IconTile
                      size="sm"
                      tone={
                        tone === "amber"
                          ? "amber"
                          : tone === "green"
                            ? "green"
                            : "blue"
                      }>
                      <FileText aria-hidden="true" className="h-4 w-4" />
                    </IconTile>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {title}
                      </div>
                      <div className="truncate text-xs text-foreground-muted">
                        {detail}
                      </div>
                    </div>
                    <span className="hidden text-xs text-foreground-muted md:block">
                      {time}
                    </span>
                    <Badge tone={tone}>{status}</Badge>
                  </Link>
                ))}
              </div>
            </Card>
          </div>
          <div className="space-y-4">
            <Card>
              <SectionTitle
                icon={<FileCheck2 aria-hidden="true" className="h-4 w-4" />}
                title="Evaluation results"
                subtitle="Quality signals from recent runs"
                action={<TinyLink href="/evaluations">View all</TinyLink>}
              />
              <div className="grid gap-4 p-4 sm:grid-cols-[112px_1fr] sm:items-center">
                <div className="mx-auto grid h-28 w-28 place-items-center rounded-full border-[10px] border-success text-center">
                  <div>
                    <strong className="text-2xl">92%</strong>
                    <div className="text-[10px] text-foreground-muted">
                      Average score
                    </div>
                    <Badge tone="green">↑ 4%</Badge>
                  </div>
                </div>
                <div className="grid min-w-0 gap-3">
                  {[
                    ["Correctness", 94, "green"],
                    ["Completeness", 91, "blue"],
                    ["Grounding", 90, "violet"],
                    ["Consistency", 88, "amber"],
                    ["Relevance", 95, "green"],
                  ].map(([name, value, tone]) => (
                    <div key={String(name)}>
                      <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                        <span>{String(name)}</span>
                        <span className="font-medium">{String(value)}%</span>
                      </div>
                      <Progress
                        value={Number(value)}
                        tone={
                          tone === "violet"
                            ? "violet"
                            : tone === "amber"
                              ? "amber"
                              : tone === "blue"
                                ? "blue"
                                : "green"
                        }
                      />
                    </div>
                  ))}
                </div>
              </div>
            </Card>
            <Card>
              <SectionTitle
                icon={<Workflow aria-hidden="true" className="h-4 w-4" />}
                title="Active workflows"
                action={<TinyLink href="/workflows/active">View all</TinyLink>}
              />
              <div className="divide-y divide-border p-4">
                {workflowItems.map(([name, repo, status, time, href]) => (
                  <Link
                    href={href}
                    key={name}
                    className="flex gap-3 py-3 first:pt-0 last:pb-0">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{name}</div>
                      <div className="mt-1 truncate text-xs text-foreground-muted">
                        {repo}
                      </div>
                    </div>
                    <div className="text-right text-xs">
                      <div
                        className={
                          status === "Scheduled"
                            ? "text-foreground-muted"
                            : "text-success"
                        }>
                        ● {status}
                      </div>
                      <div className="mt-1 text-foreground-muted">{time}</div>
                    </div>
                  </Link>
                ))}
              </div>
            </Card>
            <aside
              aria-labelledby="integration-promo-title"
              className="relative h-[292px] overflow-hidden rounded-xl border border-violet-100 bg-gradient-to-br from-violet-50/70 via-violet-50/90 to-blue-50 p-7 dark:border-violet-900/50 dark:from-violet-950/40 dark:via-violet-950/35 dark:to-blue-950/40">
              <div className="relative z-10 max-w-[270px]">
                <h3
                  id="integration-promo-title"
                  className="text-lg font-semibold leading-6 text-foreground">
                  Turn conversations
                  <br />
                  into better documentation
                </h3>
                <p className="mt-3 text-sm leading-5 text-foreground-muted">
                  Connect more data sources to help
                  <br />
                  Draftly stay up to date.
                </p>
              </div>
              <Link
                href="/integrations/add"
                className="absolute bottom-7 left-7 z-10 inline-flex h-11 items-center gap-2 rounded-lg border border-border bg-surface px-5 text-[13px] font-medium text-brand transition-colors hover:bg-surface-subtle">
                <GitPullRequest aria-hidden="true" className="h-[18px] w-[18px]" />
                Add integration
              </Link>
              <IntegrationCardIllustration />
            </aside>
          </div>
        </div>
      </div>
    </>
  );
}
