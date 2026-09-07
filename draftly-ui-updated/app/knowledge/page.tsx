import Link from "next/link";
import {
  BookOpen,
  Box,
  Cloud,
  CreditCard,
  FileText,
  Filter,
  GitBranch,
  Link2,
  LockKeyhole,
  Maximize2,
  MoreHorizontal,
  Plus,
  Scan,
  Server,
  ShieldCheck,
  Users,
} from "lucide-react";
import {
  Button,
  Card,
  MetricCard,
  PageHeader,
  Progress,
  SectionTitle,
  Tabs,
  TinyLink,
} from "@/components/ui";
const topics = [
  ["Authentication", 58],
  ["API Reference", 42],
  ["Deployment", 36],
  ["User Management", 28],
  ["SDKs", 24],
];

type SourceProvider = "github" | "slack" | "discord" | "notion" | "website" | "linear";

const knowledgeSources: Array<{
  name: string;
  detail: string;
  synced: string;
  provider: SourceProvider;
}> = [
  { name: "GitHub", detail: "authly/authly", synced: "12 min ago", provider: "github" },
  { name: "Slack", detail: "#engineering, #support", synced: "28 min ago", provider: "slack" },
  { name: "Discord", detail: "#help, #developers", synced: "1 hour ago", provider: "discord" },
  { name: "Notion", detail: "Product docs", synced: "3 hours ago", provider: "notion" },
  { name: "Website", detail: "https://authly.com", synced: "5 hours ago", provider: "website" },
  { name: "Linear", detail: "Product issues", synced: "1 day ago", provider: "linear" },
];

function SourceLogo({ provider }: { provider: SourceProvider }) {
  if (provider === "github") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-7 w-7 fill-slate-950 dark:fill-white">
        <path d="M12 .7A11.5 11.5 0 0 0 8.4 23c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.8-1.3-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.6.1-3.2 0 0 1-.3 3.3 1.2a11.4 11.4 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.6.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A11.5 11.5 0 0 0 12 .7Z" />
      </svg>
    );
  }
  if (provider === "slack") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-7 w-7">
        <rect x="10" y="1" width="4" height="9" rx="2" fill="#36C5F0" />
        <rect x="14" y="6" width="9" height="4" rx="2" fill="#2EB67D" />
        <rect x="14" y="10" width="4" height="9" rx="2" fill="#ECB22E" />
        <rect x="5" y="14" width="9" height="4" rx="2" fill="#E01E5A" />
        <rect x="6" y="5" width="4" height="9" rx="2" fill="#36C5F0" />
        <rect x="1" y="10" width="9" height="4" rx="2" fill="#E01E5A" />
        <rect x="10" y="14" width="4" height="9" rx="2" fill="#ECB22E" />
        <rect x="14" y="10" width="9" height="4" rx="2" fill="#2EB67D" />
      </svg>
    );
  }
  if (provider === "discord") {
    return (
      <svg aria-hidden="true" viewBox="0 0 28 28" className="h-7 w-7">
        <circle cx="14" cy="14" r="14" fill="#5865F2" />
        <path d="M20.4 8.9a15 15 0 0 0-3.7-1.2l-.5 1a13.8 13.8 0 0 0-4.4 0l-.5-1a15 15 0 0 0-3.7 1.2C5.3 12.3 4.7 15.6 5 18.8a15.2 15.2 0 0 0 4.5 2.3l1.1-1.5a9.7 9.7 0 0 1-1.7-.8l.4-.3a10.8 10.8 0 0 0 9.4 0l.4.3c-.6.3-1.1.6-1.7.8l1.1 1.5a15.2 15.2 0 0 0 4.5-2.3c.4-3.7-.7-7-2.6-9.9ZM11.1 16.9c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Zm5.8 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Z" fill="white" />
      </svg>
    );
  }
  if (provider === "notion") {
    return (
      <svg aria-hidden="true" viewBox="0 0 28 28" className="h-7 w-7">
        <rect x="2" y="2" width="24" height="24" rx="2" fill="white" stroke="#111827" strokeWidth="2" />
        <path d="M8 7.5h7.2l5 6.2V9.8l-2-.4V7.5H24v1.9l-1.8.4v11h-2.4L11.1 10v8.1l2.3.5v1.8H7v-1.8l2-.5V9.8L8 9.4V7.5Z" fill="#111827" />
      </svg>
    );
  }
  if (provider === "linear") {
    return (
      <svg aria-hidden="true" viewBox="0 0 28 28" className="h-7 w-7">
        <circle cx="14" cy="14" r="14" fill="#6C4CF1" />
        <path d="m6.3 11.1 10.6 10.6a8.2 8.2 0 0 1-10.6-10.6Zm.5-2.5 12.6 12.6c.6-.5 1.1-1.1 1.5-1.7L8.5 7.1c-.6.4-1.2.9-1.7 1.5Zm3.6-2.4 11.4 11.4c.3-.8.5-1.6.6-2.5L12.9 5.6c-.9.1-1.7.3-2.5.6Zm5.6-.4 6.2 6.2A8.2 8.2 0 0 0 16 5.8Z" fill="white" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 28 28" className="h-7 w-7">
      <circle cx="14" cy="14" r="12" fill="#111827" />
      <circle cx="14" cy="14" r="7" stroke="white" strokeWidth="1.5" />
      <path d="M7 14h14M14 7c2 2.1 3 4.4 3 7s-1 4.9-3 7c-2-2.1-3-4.4-3-7s1-4.9 3-7Z" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
const graphNodes = [
  {
    label: "Authentication",
    x: 43,
    y: 16,
    icon: ShieldCheck,
    tone: "bg-violet-100 text-violet-600",
  },
  {
    label: "Billing",
    x: 64,
    y: 29,
    icon: CreditCard,
    tone: "bg-amber-100 text-amber-500",
  },
  {
    label: "User Management",
    x: 71,
    y: 54,
    icon: Users,
    tone: "bg-violet-100 text-violet-600",
  },
  {
    label: "Integrations",
    x: 64,
    y: 80,
    icon: Link2,
    tone: "bg-cyan-100 text-cyan-600",
  },
  {
    label: "Security",
    x: 42,
    y: 86,
    icon: LockKeyhole,
    tone: "bg-rose-100 text-rose-500",
  },
  {
    label: "Deployment",
    x: 20,
    y: 76,
    icon: Cloud,
    tone: "bg-orange-100 text-orange-500",
  },
  {
    label: "SDKs",
    x: 11,
    y: 52,
    icon: Box,
    tone: "bg-emerald-100 text-emerald-500",
  },
  {
    label: "API Reference",
    x: 23,
    y: 26,
    icon: Server,
    tone: "bg-blue-100 text-blue-600",
  },
];
const graphLegend = [
  ["Product", "bg-violet-500"],
  ["Feature", "bg-indigo-500"],
  ["API", "bg-blue-500"],
  ["Guide", "bg-amber-500"],
  ["Concept", "bg-purple-400"],
  ["Integration", "bg-emerald-500"],
  ["Security", "bg-rose-500"],
  ["Other", "bg-cyan-500"],
];
function KnowledgeGraph() {
  return (
    <Card>
      <SectionTitle
        icon={<GitBranch aria-hidden="true" className="h-4 w-4" />}
        title="Knowledge graph"
        subtitle="Explore how your product knowledge is connected."
        action={
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="inline-flex h-8 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-[11px] text-foreground-secondary hover:bg-surface-subtle">
              <Scan aria-hidden="true" className="h-3.5 w-3.5" />
              Fit view
            </button>
            <button
              type="button"
              className="inline-flex h-8 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-[11px] text-foreground-secondary hover:bg-surface-subtle">
              <Filter aria-hidden="true" className="h-3.5 w-3.5" />
              Filters
            </button>
            <button
              type="button"
              aria-label="Expand knowledge graph"
              className="grid h-8 w-8 place-items-center rounded-lg border border-border bg-surface text-foreground-secondary hover:bg-surface-subtle">
              <Maximize2 aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          </div>
        }
      />
      <div className="grid-bg relative h-[330px] overflow-hidden rounded-b-2xl">
        <svg
          aria-hidden="true"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full">
          {graphNodes.map((node) => (
            <line
              key={node.label}
              x1="43"
              y1="50"
              x2={node.x}
              y2={node.y}
              stroke="rgb(var(--border-strong))"
              strokeWidth=".35"
            />
          ))}
        </svg>

        <div className="absolute left-[43%] top-1/2 -translate-x-1/2 -translate-y-1/2">
          <div className="grid h-20 w-20 place-items-center rounded-full bg-blue-50/80">
            <div className="grid h-14 w-14 place-items-center rounded-full bg-blue-600 text-white shadow-md">
              <FileText aria-hidden="true" className="h-5 w-5" />
            </div>
          </div>
          <div className="mt-1 text-center text-[11px] font-medium">Authly</div>
        </div>

        {graphNodes.map(({ label, x, y, icon: Icon, tone }) => (
          <div
            key={label}
            style={{ left: `${x}%`, top: `${y}%` }}
            className="absolute flex -translate-x-6 -translate-y-6 items-center gap-2">
            <div
              className={`grid h-12 w-12 shrink-0 place-items-center rounded-full ${tone}`}>
              <Icon aria-hidden="true" className="h-5 w-5" />
            </div>
            <span className="whitespace-nowrap text-[11px] font-medium text-foreground-secondary">
              {label}
            </span>
          </div>
        ))}

        <div className="absolute right-8 top-5 space-y-2.5 text-[10px] text-foreground-secondary">
          {graphLegend.map(([label, color]) => (
            <div key={label} className="flex items-center gap-3">
              <span className={`h-2 w-2 rounded-full ${color}`} />
              <span>{label}</span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
export default function Page() {
  return (
    <>
      <PageHeader
        title="Knowledge"
        subtitle="Your product knowledge, organized and connected. Powering accurate, grounded documentation."
        actions={
          <div className="flex gap-2">
            <Button>Import source</Button>
            <Button primary>
              <Plus className="h-4 w-4" />
              Add source
            </Button>
          </div>
        }
      />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Knowledge items"
          value="1,248"
          sub="Across all sources"
          trend="12%"
          icon={<FileText className="h-5 w-5" />}
        />
        <MetricCard
          label="Connected sources"
          value="8"
          sub="GitHub, Slack, Discord, etc."
          icon={<GitBranch className="h-5 w-5" />}
        />
        <MetricCard
          label="Linked concepts"
          value="324"
          sub="In the knowledge graph"
          trend="18%"
          tone="green"
          icon={<Link2 className="h-5 w-5" />}
        />
        <MetricCard
          label="Repositories"
          value="6"
          sub="Actively monitored"
          icon={<Box className="h-5 w-5" />}
        />
      </div>
      <div className="mt-4">
        <Tabs
          active="Overview"
          items={[
            { label: "Overview", href: "/knowledge" },
            { label: "Documents", href: "/knowledge/documents" },
            { label: "Sources", href: "/knowledge/sources" },
            { label: "Knowledge Graph", href: "/knowledge/graph" },
            { label: "Topics", href: "/knowledge/topics" },
            { label: "Embeddings", href: "/knowledge/embeddings" },
          ]}
        />
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-[1.5fr_.85fr]">
        <div className="space-y-4">
          <KnowledgeGraph />
          <div className="space-y-4">
            <Card className="overflow-hidden">
              <SectionTitle
                icon={<FileText aria-hidden="true" className="h-4 w-4" />}
                title="Recent knowledge items"
                subtitle="Latest content ingested and processed into knowledge."
                action={
                  <Link
                    href="/knowledge/documents"
                    className="text-[11px] font-medium text-brand hover:underline">
                    View all
                  </Link>
                }
              />
              <div className="mt-2 overflow-x-auto">
                <div className="min-w-[680px]">
                  <div className="grid h-8 grid-cols-[minmax(0,1.7fr)_120px_100px_100px_28px] items-center gap-3 bg-surface-muted px-5 text-[10px] font-medium text-foreground-muted">
                    <span>Title</span>
                    <span>Source</span>
                    <span>Type</span>
                    <span>Updated</span>
                    <span />
                  </div>
                  <div className="divide-y divide-border px-5">
                    {[
                      ["OAuth 2.0 authentication flow", "GitHub", "Document", "12 min ago"],
                      ["Refresh token rotation", "Slack", "Discussion", "45 min ago"],
                      ["Rate limits for API v2", "GitHub", "Issue", "1 hour ago"],
                      ["SDK installation guide", "Website", "Document", "3 hours ago"],
                      ["Deployment with Kubernetes", "Notion", "Document", "5 hours ago"],
                    ].map(([title, source, type, updated]) => (
                      <div
                        key={title}
                        className="grid h-[46px] grid-cols-[minmax(0,1.7fr)_120px_100px_100px_28px] items-center gap-3 text-[11px]">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-blue-50 text-blue-600">
                            <FileText aria-hidden="true" className="h-3.5 w-3.5" />
                          </span>
                          <span className="truncate font-medium text-foreground">{title}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="grid h-5 w-5 shrink-0 place-items-center [&>svg]:h-5 [&>svg]:w-5">
                            <SourceLogo provider={source.toLowerCase() as SourceProvider} />
                          </span>
                          <span>{source}</span>
                        </div>
                        <span className="text-foreground-secondary">{type}</span>
                        <span className="text-foreground-muted">{updated}</span>
                        <button
                          type="button"
                          aria-label={`More options for ${title}`}
                          className="grid h-7 w-7 place-items-center rounded-md text-foreground-secondary hover:bg-surface-subtle">
                          <MoreHorizontal aria-hidden="true" className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </Card>
          </div>
        </div>
        <div className="space-y-4">
          <Card className="h-[378px] overflow-hidden">
            <SectionTitle
              icon={<GitBranch aria-hidden="true" className="h-4 w-4" />}
              title="Knowledge sources"
              subtitle="Manage and monitor your connected sources."
              action={
                <Link
                  href="/knowledge/sources"
                  className="text-[11px] font-medium text-brand hover:underline">
                  View all
                </Link>
              }
            />
            <div className="mt-2 grid h-[322px] grid-rows-6 divide-y divide-border px-5">
              {knowledgeSources.map((source) => (
                <div
                  key={source.name}
                  className="grid grid-cols-[32px_minmax(0,1fr)_130px_28px] items-center gap-3">
                  <SourceLogo provider={source.provider} />
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium text-foreground">
                      {source.name}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-foreground-muted">
                      {source.detail}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="flex items-center justify-end gap-2 text-[11px] text-foreground-secondary">
                      <span
                        aria-hidden="true"
                        className="h-2 w-2 rounded-full bg-emerald-500"
                      />
                      Connected
                    </div>
                    <div className="mt-0.5 whitespace-nowrap text-[10px] text-foreground-muted">
                      Last sync {source.synced}
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label={`More options for ${source.name}`}
                    className="grid h-7 w-7 place-items-center rounded-md text-foreground-secondary hover:bg-surface-subtle">
                    <MoreHorizontal aria-hidden="true" className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          </Card>
          <Card>
            <SectionTitle
              icon={<BookOpen className="h-4 w-4" />}
              title="Top topics"
              action={<TinyLink>View all</TinyLink>}
            />
            <div className="space-y-3 p-4">
              {topics.map(([n, v], i) => (
                <div
                  key={n as string}
                  className="grid grid-cols-[18px_1fr_110px_24px] items-center gap-2 text-xs">
                  <span>{i + 1}</span>
                  <span>{n}</span>
                  <Progress
                    value={Math.min(100, (v as number) * 1.5)}
                    tone="blue"
                  />
                  <span>{v}</span>
                </div>
              ))}
            </div>
          </Card>
          <Card>
            <SectionTitle
              icon={<Box className="h-4 w-4" />}
              title="Content by source"
            />
            <div className="p-4">
              <div className="flex h-3 overflow-hidden rounded-full">
                <div className="w-[42%] bg-blue-600" />
                <div className="w-[22%] bg-cyan-500" />
                <div className="w-[12%] bg-violet-500" />
                <div className="w-[10%] bg-rose-400" />
                <div className="w-[14%] bg-amber-300" />
              </div>
              <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-slate-500">
                <span>GitHub 42%</span>
                <span>Slack 22%</span>
                <span>Discord 12%</span>
                <span>Notion 10%</span>
                <span>Other 14%</span>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
