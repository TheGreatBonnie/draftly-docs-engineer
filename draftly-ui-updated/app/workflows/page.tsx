import Link from "next/link";
import {
  CalendarClock,
  FileCheck2,
  GitPullRequest,
  MessageSquare,
  Play,
  Plus,
  RefreshCcw,
  Tag,
  Workflow as WorkflowIcon,
} from "lucide-react";
import { SectionTabs } from "@/components/section-tabs";
import {
  Badge,
  Button,
  Card,
  IconTile,
  MetricCard,
  PageHeader,
  SearchBox,
  SelectPill,
} from "@/components/ui";
import { workflows } from "@/lib/mock-data";

const icons = [
  GitPullRequest,
  Tag,
  FileCheck2,
  MessageSquare,
  CalendarClock,
  FileCheck2,
  RefreshCcw,
  WorkflowIcon,
];
const slug = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

export default function Page() {
  return (
    <>
      <PageHeader
        title="Workflows"
        subtitle="Automate documentation for your entire development lifecycle."
        actions={
          <Link href="/workflows/new">
            <Button primary>
              <Plus className="h-4 w-4" />
              New workflow
            </Button>
          </Link>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Active workflows"
          value="6"
          sub="Across all repositories"
          trend="2"
          icon={<Play className="h-5 w-5" />}
        />
        <MetricCard
          label="Total runs"
          value="248"
          sub="Last 30 days"
          trend="18%"
          icon={<WorkflowIcon className="h-5 w-5" />}
        />
        <MetricCard
          label="Success rate"
          value="92%"
          sub="Across all runs"
          trend="4%"
          tone="green"
          icon={<FileCheck2 className="h-5 w-5" />}
        />
        <MetricCard
          label="Avg. run time"
          value="1.2h"
          sub="From 1.5h"
          trend="22%"
          tone="amber"
          icon={<CalendarClock className="h-5 w-5" />}
        />
      </div>

      <div className="mt-4">
        <SectionTabs section="workflows" />
      </div>

      <div className="mt-4 flex min-w-0 flex-wrap gap-2">
        <SearchBox
          className="min-w-[220px] flex-1"
          placeholder="Search workflows..."
        />
        <SelectPill>All types</SelectPill>
        <SelectPill>Sort by</SelectPill>
      </div>

      <div className="mt-4 grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_330px]">
        <Card className="min-w-0 overflow-hidden">
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {workflows.map((workflow, index) => {
              const Icon = icons[index] || WorkflowIcon;
              return (
                <div
                  key={workflow[0] as string}
                  className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
                  <div className="flex min-w-0 flex-1 gap-3">
                    <IconTile
                      tone={
                        index % 4 === 2
                          ? "rose"
                          : index % 4 === 1
                            ? "violet"
                            : index % 4 === 3
                              ? "cyan"
                              : "blue"
                      }>
                      <Icon className="h-5 w-5" />
                    </IconTile>
                    <div className="min-w-0">
                      <Link
                        href={`/workflows/${slug(workflow[0] as string)}`}
                        className="text-sm font-semibold hover:text-blue-600">
                        {workflow[0]}
                      </Link>
                      <div className="mt-1 text-xs text-slate-500">
                        {workflow[1]}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1">
                        <Badge>documentation</Badge>
                        <Badge tone="violet">
                          {index % 2 ? "automation" : "github"}
                        </Badge>
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-xs sm:w-[300px] sm:grid-cols-[1fr_1fr_auto]">
                    <div>
                      <div className="text-slate-400">Trigger</div>
                      <div className="mt-1">{workflow[2]}</div>
                    </div>
                    <div>
                      <div className="text-slate-400">Last run</div>
                      <div className="mt-1">{workflow[3]}</div>
                      <div
                        className={`mt-1 ${workflow[4] === "Success" ? "text-emerald-600" : "text-amber-600"}`}>
                        ● {workflow[4]}
                      </div>
                    </div>
                    <button
                      aria-label="Toggle workflow"
                      className={`self-center h-6 w-11 rounded-full p-1 ${workflow[5] ? "bg-blue-600" : "bg-slate-200"}`}>
                      <span
                        className={`block h-4 w-4 rounded-full bg-white transition ${workflow[5] ? "ml-5" : ""}`}
                      />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <aside className="min-w-0 space-y-4">
          <Card className="p-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Workflow details</h3>
              <Link href="/workflows/pr-documentation">
                <Button>Edit</Button>
              </Link>
            </div>
            <div className="mt-4 flex gap-3">
              <IconTile>
                <GitPullRequest className="h-5 w-5" />
              </IconTile>
              <div className="min-w-0">
                <div className="font-semibold">PR Documentation</div>
                <p className="text-xs text-slate-500">
                  Generate and update documentation from pull requests.
                </p>
              </div>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-y-3 text-xs">
              <dt className="text-slate-500">Status</dt>
              <dd className="text-emerald-600">● Active</dd>
              <dt className="text-slate-500">Trigger</dt>
              <dd>PR opened/updated</dd>
              <dt className="text-slate-500">Last run</dt>
              <dd>12 min ago</dd>
              <dt className="text-slate-500">Success rate</dt>
              <dd>94%</dd>
            </dl>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <Link href="/workflows/pr-documentation">
                <Button className="w-full">
                  <Play className="h-4 w-4" />
                  Open
                </Button>
              </Link>
              <Link href="/workflows/pr-documentation/runs/run_1942">
                <Button className="w-full">View run</Button>
              </Link>
            </div>
          </Card>
          <Card className="p-4">
            <h3 className="font-semibold">Workflow templates</h3>
            {[
              "Documentation from PRs",
              "Release notes",
              "Scheduled documentation audit",
            ].map((template) => (
              <div
                key={template}
                className="mt-3 flex items-center justify-between text-sm">
                <span>{template}</span>
                <Link
                  href="/workflows/new"
                  className="text-xs font-medium text-blue-600">
                  Use →
                </Link>
              </div>
            ))}
          </Card>
        </aside>
      </div>
    </>
  );
}
