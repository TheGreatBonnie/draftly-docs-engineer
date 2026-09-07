import Link from "next/link";
import { SectionTabs } from "@/components/section-tabs";
import {
  Activity,
  CalendarDays,
  FileText,
  Github,
  MessageSquare,
  Play,
  SlidersHorizontal,
  Workflow,
  ShieldCheck,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  IconTile,
  MetricCard,
  PageHeader,
  SectionTitle,
  SelectPill,
  Tabs,
} from "@/components/ui";
import { activityItems } from "@/lib/mock-data";
const iconMap: Record<string, typeof Activity> = {
  github: Github,
  file: FileText,
  workflow: Workflow,
  message: MessageSquare,
};
export default function Page() {
  return (
    <>
      <PageHeader
        title="Activity"
        subtitle="A real-time view of everything happening in Draftly. Track events, runs, document changes, and system activity across your connected sources."
        actions={
          <>
            <SelectPill>
              <CalendarDays className="h-4 w-4" />
              Aug 25, 2026 – Sep 5, 2026
            </SelectPill>
            <Button>Export</Button>
          </>
        }
      />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Document changes"
          value="142"
          sub="In the last 7 days"
          trend="12%"
          icon={<FileText className="h-5 w-5" />}
        />
        <MetricCard
          label="Workflow runs"
          value="48"
          sub="In the last 7 days"
          trend="20%"
          icon={<Play className="h-5 w-5" />}
        />
        <MetricCard
          label="Support conversations"
          value="36"
          sub="In the last 7 days"
          trend="8%"
          tone="violet"
          icon={<MessageSquare className="h-5 w-5" />}
        />
        <MetricCard
          label="Repository events"
          value="28"
          sub="In the last 7 days"
          trend="27%"
          tone="rose"
          icon={<Github className="h-5 w-5" />}
        />
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_320px]">
        <div className="min-w-0">
          <SectionTabs section="activity" />
          <Card className="mt-4 overflow-hidden">
            <div className="border-b border-slate-100 bg-slate-50 px-4 py-2 text-xs font-semibold">
              Today
            </div>
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {activityItems.map((e, i) => {
                const Icon = iconMap[e.icon] || Activity;
                return (
                  <Link
                    href={`/activity/${e.id}`}
                    key={e.id}
                    className="flex gap-3 p-4 hover:bg-slate-50">
                    <div className="hidden w-16 shrink-0 pt-2 text-xs text-slate-500 sm:block">
                      {e.time}
                    </div>
                    <IconTile
                      size="sm"
                      tone={
                        i % 3 === 0 ? "blue" : i % 3 === 1 ? "violet" : "green"
                      }>
                      <Icon className="h-4 w-4" />
                    </IconTile>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{e.title}</span>
                        <span className="text-[11px] text-slate-400 sm:hidden">
                          {e.time}
                        </span>
                      </div>
                      <div className="mt-0.5 text-xs text-slate-500">
                        {e.detail}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <Badge>{e.source}</Badge>
                        <Badge
                          tone={
                            e.type.includes("review")
                              ? "rose"
                              : e.type === "Success"
                                ? "green"
                                : "slate"
                          }>
                          {e.type}
                        </Badge>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
            <div className="border-y border-slate-100 bg-slate-50 px-4 py-2 text-xs font-semibold">
              Yesterday
            </div>
            {[
              [
                FileText,
                "New document created",
                "Rate limits and quotas guide",
                "6:12 PM",
              ],
              [
                MessageSquare,
                "New Discord discussion",
                "Clarification on PKCE implementation",
                "4:45 PM",
              ],
              [
                ShieldCheck,
                "Human review approved",
                "SDK installation guide",
                "3:22 PM",
              ],
            ].map(([Icon, title, sub, time]) => (
              <div
                key={String(title)}
                className="flex gap-3 border-b border-slate-100 p-4">
                <IconTile size="sm" tone="slate">
                  <Icon className="h-4 w-4" />
                </IconTile>
                <div className="flex-1">
                  <div className="text-sm font-medium">{String(title)}</div>
                  <div className="text-xs text-slate-500">{String(sub)}</div>
                </div>
                <span className="text-xs text-slate-400">{String(time)}</span>
              </div>
            ))}
          </Card>
        </div>
        <aside className="space-y-4">
          <Card>
            <SectionTitle
              icon={<SlidersHorizontal className="h-4 w-4" />}
              title="Filters"
            />
            <div className="space-y-4 p-4 text-sm">
              <SelectPill className="w-full">All sources</SelectPill>
              <SelectPill className="w-full">All statuses</SelectPill>
              <SelectPill className="w-full">All actors</SelectPill>
              {[
                "Document changes",
                "Workflow runs",
                "Evaluations",
                "Support conversations",
                "Repository events",
                "System events",
              ].map((x, i) => (
                <label
                  key={x}
                  className="flex items-center justify-between text-xs">
                  <span>
                    <input
                      defaultChecked
                      type="checkbox"
                      className="mr-2 accent-blue-600"
                    />
                    {x}
                  </span>
                  <span className="text-slate-400">
                    {[142, 48, 22, 36, 28, 14][i]}
                  </span>
                </label>
              ))}
            </div>
          </Card>
          <Card>
            <SectionTitle title="Activity by source" />
            <div className="flex flex-wrap items-center gap-5 p-5">
              <div
                className="relative h-28 w-28 rounded-full"
                style={{
                  background:
                    "conic-gradient(#111827 0 28%,#10b981 28% 52%,#7c3aed 52% 64%,#3b82f6 64% 74%,#f59e0b 74% 82%,#cbd5e1 82%)",
                }}>
                <div className="absolute inset-5 grid place-items-center rounded-full bg-white text-center">
                  <div>
                    <strong>290</strong>
                    <div className="text-[10px] text-slate-500">
                      Total events
                    </div>
                  </div>
                </div>
              </div>
              <div className="space-y-2 text-xs">
                <div>GitHub 28%</div>
                <div>Slack 24%</div>
                <div>Discord 12%</div>
                <div>System 10%</div>
              </div>
            </div>
          </Card>
        </aside>
      </div>
    </>
  );
}
