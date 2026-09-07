import Link from "next/link";
import {
  Bot,
  Boxes,
  CheckCircle2,
  Database,
  Github,
  MessageSquare,
  Play,
  Plus,
  Search,
  Send,
  Star,
  Timer,
  Users,
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
  Tabs,
} from "@/components/ui";
import { agents } from "@/lib/mock-data";

const agentIcons = [
  Bot,
  Search,
  CheckCircle2,
  Github,
  MessageSquare,
  Database,
  Star,
  Send,
  Timer,
];
const agentTones = [
  "blue",
  "violet",
  "green",
  "amber",
  "blue",
  "rose",
  "violet",
  "cyan",
  "amber",
] as const;
const slug = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

export default function Page() {
  return (
    <>
      <PageHeader
        title="Agents"
        subtitle="Specialized AI agents that power Draftly's documentation intelligence."
        actions={
          <>
            <Button>View architecture</Button>
            <Link href="/agents/new">
              <Button primary>
                <Plus className="h-4 w-4" />
                New agent
              </Button>
            </Link>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Active agents"
          value="8"
          sub="2 idle • 0 errors"
          trend="14%"
          icon={<Users className="h-5 w-5" />}
        />
        <MetricCard
          label="Total skills"
          value="24"
          sub="Across all agents"
          trend="20%"
          icon={<Boxes className="h-5 w-5" />}
        />
        <MetricCard
          label="Tasks completed"
          value="1,248"
          sub="Last 7 days"
          trend="32%"
          icon={<Bot className="h-5 w-5" />}
        />
        <MetricCard
          label="Success rate"
          value="98%"
          sub="Across all agents"
          trend="2%"
          tone="green"
          icon={<CheckCircle2 className="h-5 w-5" />}
        />
      </div>

      <div className="mt-4">
        <SectionTabs section="agents" />
      </div>

      <div className="mt-4 flex min-w-0 flex-wrap gap-2">
        <SearchBox
          className="min-w-[220px] flex-1"
          placeholder="Search agents..."
        />
        <SelectPill>All types</SelectPill>
        <SelectPill>All status</SelectPill>
      </div>

      <div className="mt-4 grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {agents.map((agent, index) => {
              const Icon = agentIcons[index] || Bot;
              return (
                <Card key={agent[0] as string} className="min-w-0 p-4">
                  <div className="flex items-start gap-3">
                    <IconTile tone={agentTones[index]}>
                      <Icon className="h-5 w-5" />
                    </IconTile>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <Link
                          href={`/agents/${slug(agent[0] as string)}`}
                          className="truncate text-sm font-semibold hover:text-blue-600">
                          {agent[0]}
                        </Link>
                        <span className="shrink-0 text-slate-400">•••</span>
                      </div>
                      <div className="mt-1">
                        <Badge tone={agent[3] === "Active" ? "green" : "slate"}>
                          ● {agent[3]}
                        </Badge>
                      </div>
                    </div>
                  </div>
                  <p className="mt-4 min-h-[54px] text-xs leading-5 text-slate-500">
                    {agent[1]}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-1">
                    {(agent[2] as string).split(", ").map((skill) => (
                      <Badge key={skill}>{skill}</Badge>
                    ))}
                  </div>
                  <div className="mt-4 flex justify-between gap-3 border-t border-slate-100 pt-3 text-xs text-slate-500 dark:border-slate-800">
                    <span>{agent[4]}</span>
                    <span className="truncate">Last run {agent[5]}</span>
                  </div>
                </Card>
              );
            })}
          </div>
        </div>

        <aside className="min-w-0 space-y-4">
          <Card className="p-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Agent details</h3>
              <Link href="/agents/documentation-agent">
                <Button>Edit</Button>
              </Link>
            </div>
            <div className="mt-4 flex gap-3">
              <IconTile>
                <Bot className="h-5 w-5" />
              </IconTile>
              <div className="min-w-0">
                <div className="font-semibold">Documentation Agent</div>
                <Badge tone="green">Active</Badge>
                <p className="mt-2 text-xs text-slate-500">
                  Generates, updates, and maintains accurate documentation.
                </p>
              </div>
            </div>
            <Tabs
              className="mt-4"
              active="Overview"
              items={["Overview", "Skills", "Configuration"]}
            />
            <dl className="mt-4 grid grid-cols-2 gap-y-3 text-xs">
              <dt className="text-slate-500">Model</dt>
              <dd className="min-w-0 truncate">Claude 3.5 Sonnet</dd>
              <dt className="text-slate-500">Version</dt>
              <dd>v1.2.0</dd>
              <dt className="text-slate-500">Success rate</dt>
              <dd>97%</dd>
              <dt className="text-slate-500">Total runs</dt>
              <dd>342</dd>
            </dl>
            <Link href="/agents/documentation-agent">
              <Button primary className="mt-4 w-full">
                <Play className="h-4 w-4" />
                Open agent
              </Button>
            </Link>
          </Card>
        </aside>
      </div>
    </>
  );
}
