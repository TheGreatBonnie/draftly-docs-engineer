import Link from "next/link";
import { SectionTabs } from "@/components/section-tabs";
import { FileText, Github, Plus } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  MetricCard,
  PageHeader,
  SearchBox,
  SelectPill,
} from "@/components/ui";
import { docs } from "@/lib/mock-data";
export default function Page() {
  return (
    <>
      <PageHeader
        title="Documentation"
        subtitle="Browse, search, and manage your project documentation. Keep your docs accurate, complete, and always in sync."
        actions={
          <div className="flex gap-2">
            <Button>View site ↗</Button>
            <Button primary>
              <Plus className="h-4 w-4" />
              New document
            </Button>
          </div>
        }
      />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Total documents"
          value="318"
          sub="Across all repositories"
          trend="12%"
          icon={<FileText className="h-5 w-5" />}
        />
        <MetricCard
          label="Up to date"
          value="284"
          sub="89% of total"
          trend="8%"
          tone="green"
          icon={<FileText className="h-5 w-5" />}
        />
        <MetricCard
          label="Needs update"
          value="24"
          sub="7% of total"
          trend="33%"
          tone="amber"
          icon={<FileText className="h-5 w-5" />}
        />
        <MetricCard
          label="Outdated"
          value="8"
          sub="3% of total"
          trend="14%"
          tone="rose"
          icon={<FileText className="h-5 w-5" />}
        />
      </div>
      <div className="mt-4 min-w-0">
        <div className="min-w-0">
          <SectionTabs section="documentation" />
          <div className="my-4 flex min-w-0 flex-wrap gap-2">
            <SearchBox
              className="min-w-[260px] flex-1"
              placeholder="Search documents..."
            />
            <SelectPill>Repository</SelectPill>
            <SelectPill>Type</SelectPill>
            <SelectPill>Status</SelectPill>
            <SelectPill>Topic</SelectPill>
            <SelectPill>All time</SelectPill>
          </div>
          <Card className="min-w-0 overflow-hidden">
            <div className="overflow-x-auto">
              <div className="min-w-[900px]">
                <div className="grid grid-cols-[minmax(0,2fr)_minmax(100px,.8fr)_minmax(90px,.7fr)_minmax(100px,.7fr)_minmax(120px,.9fr)_25px] gap-3 border-b border-slate-100 bg-slate-50 px-4 py-3 text-xs text-slate-500">
                  <span>Title</span>
                  <span>Repository</span>
                  <span>Type</span>
                  <span>Status</span>
                  <span>Last updated</span>
                  <span />
                </div>
                <div className="divide-y divide-slate-100 dark:divide-slate-800">
                  {docs.map((d, i) => (
                    <div
                      key={d[0]}
                      className="grid grid-cols-[minmax(0,2fr)_minmax(100px,.8fr)_minmax(90px,.7fr)_minmax(100px,.7fr)_minmax(120px,.9fr)_25px] gap-3 px-4 py-4 text-xs">
                      <div className="flex min-w-0 gap-3">
                        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-blue-50 text-blue-600">
                          <FileText className="h-4 w-4" />
                        </div>
                        <div className="min-w-0">
                          <Link
                            href={
                              i === 0
                                ? "/documentation/oauth-2-0-integration"
                                : "/documentation/" +
                                  d[0]
                                    .toLowerCase()
                                    .replace(/[^a-z0-9]+/g, "-")
                                    .replace(/(^-|-$)/g, "")
                            }
                            className="block truncate text-sm font-medium hover:text-blue-600">
                            {d[0]}
                          </Link>
                          <div className="line-clamp-2 text-slate-500">
                            {d[1]}
                          </div>
                        </div>
                      </div>
                      <span className="inline-flex min-w-0 items-center gap-1 truncate">
                        <Github className="h-3.5 w-3.5 shrink-0" />
                        Authly
                      </span>
                      <span className="min-w-0">
                        <Badge
                          tone={
                            i % 3 === 1
                              ? "violet"
                              : i % 3 === 2
                                ? "green"
                                : "blue"
                          }>
                          {d[2]}
                        </Badge>
                      </span>
                      <span className="min-w-0">
                        <Badge
                          tone={
                            d[3] === "Up to date"
                              ? "green"
                              : d[3] === "Outdated"
                                ? "rose"
                                : "amber"
                          }>
                          {d[3]}
                        </Badge>
                      </span>
                      <span className="min-w-0 truncate">
                        {d[4]}
                        <br />
                        <span className="text-slate-400">
                          by {i === 2 || i === 6 ? "Bonnie K." : "Draftly"}
                        </span>
                      </span>
                      <span>•••</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
