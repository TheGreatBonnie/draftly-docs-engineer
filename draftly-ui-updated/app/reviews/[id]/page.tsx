import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  Clock3,
  FileCheck2,
  FileText,
  Github,
  MessageSquare,
} from "lucide-react";
import ReviewActions from "@/components/review-actions";
import ReviewDocument from "@/components/review-document";
import { Badge, Button, Card, Progress, SectionTitle, Tabs } from "@/components/ui";
import { reviews } from "@/lib/mock-data";

const statusTone = (status: string) => {
  if (status === "Approved") return "green";
  if (status === "Urgent") return "rose";
  if (status === "Needs changes") return "amber";
  return "blue";
};

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const review = reviews.find((item) => item.id === id);

  if (!review) notFound();

  const evidence = [
    ["GitHub PR #142", "Add refresh token support for OAuth", "3 references"],
    ["GitHub Issue #87", "Support refresh token rotation", "2 references"],
    ["Slack discussion", "#engineering • Aug 28, 2026", "4 references"],
    ["Implementation files", "auth/oauth.py, auth/routes.py", "6 references"],
    ["Existing documentation", review.path, "1 reference"],
  ];

  return (
    <>
      <div className="mb-3 flex items-center gap-2 text-sm text-foreground-muted">
        <Link className="flex items-center gap-1 hover:text-brand" href="/reviews">
          <ArrowLeft className="h-4 w-4" /> Reviews
        </Link>
        <span>›</span>
        <span>{review.title}</span>
      </div>

      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold">{review.title}</h1>
            <Badge tone="violet">{review.ref}</Badge>
            <Badge tone={statusTone(review.status)}>{review.status}</Badge>
          </div>
          <p className="mt-1 text-sm text-foreground-muted">{review.description}</p>
          <div className="mt-4 grid gap-3 text-xs sm:grid-cols-2 xl:grid-cols-4">
            <div className="flex gap-2">
              <Github className="h-4 w-4 text-foreground-muted" />
              <span>{review.repo}<br /><b className="text-foreground">Repository</b></span>
            </div>
            <div className="flex gap-2">
              <FileText className="h-4 w-4 text-foreground-muted" />
              <span>{review.path}<br /><b className="text-foreground">Affected file</b></span>
            </div>
            <div className="flex gap-2">
              <FileCheck2 className="h-4 w-4 text-foreground-muted" />
              <span>{review.type}<br /><b className="text-foreground">Change type</b></span>
            </div>
            <div className="flex gap-2">
              <Clock3 className="h-4 w-4 text-foreground-muted" />
              <span>Aug 29, 2026, 10:24 AM<br /><b className="text-foreground">Generated {review.updated}</b></span>
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <Button>View in GitHub</Button>
          <Button ariaLabel="More review actions">•••</Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between border-b border-border">
        <Tabs active="Overview" items={["Overview", "Proposed changes", "Evidence", "Evaluation", "Agent activity", "Comments"]} />
        <div className="mb-2"><ReviewActions /></div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.55fr_.9fr]">
        <div className="min-w-0 space-y-4">
          <Card className="min-w-0">
            <SectionTitle icon={<FileText className="h-4 w-4" />} title="Why this review exists" />
            <p className="px-4 pt-2 text-sm leading-6 text-foreground-secondary">
              {review.description} Draftly generated the proposed document below for human review.
            </p>
            <div className="grid gap-3 p-4 sm:grid-cols-5">
              {[
                ["Trigger", review.ref],
                ["Repository", review.repo],
                ["Change type", review.type],
                ["Risk level", review.risk],
                ["Evaluation score", `${review.score}%`],
              ].map(([label, value]) => (
                <div className="rounded-xl border border-border p-3" key={label}>
                  <div className="text-xs text-foreground-muted">{label}</div>
                  <div className="mt-2 text-sm font-semibold">{value}</div>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <SectionTitle
              icon={<Github className="h-4 w-4" />}
              subtitle="Review the formatted document, its line changes, or the raw Markdown."
              title="Proposed changes"
            />
            <ReviewDocument
              originalContent={review.document.originalContent}
              path={review.path}
              proposedContent={review.document.proposedContent}
            />
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          <Card>
            <SectionTitle title="Evaluation" action={<span className="text-xs font-medium text-brand">View full report →</span>} />
            <div className="flex gap-4 p-4">
              <div className="grid h-32 w-32 place-items-center rounded-full border-[12px] border-success">
                <div className="text-center">
                  <strong className="text-2xl">{review.score}%</strong>
                  <div className="text-[10px] text-foreground-muted">Overall score</div>
                </div>
              </div>
              <div className="flex-1 space-y-3">
                {[["Correctness", 98], ["Completeness", 91], ["Grounding", 96], ["Consistency", 92], ["Documentation quality", 90]].map(([name, value]) => (
                  <div key={name as string}>
                    <div className="mb-1 flex justify-between text-xs"><span>{name}</span><span>{value}%</span></div>
                    <Progress tone="green" value={value as number} />
                  </div>
                ))}
              </div>
            </div>
          </Card>

          <Card>
            <SectionTitle title="Evidence" action={<span className="text-xs font-medium text-brand">View all →</span>} />
            <div className="divide-y divide-border p-4">
              {evidence.map(([title, detail, count], index) => (
                <div className="flex items-center gap-3 py-3" key={title}>
                  <div className="grid h-9 w-9 place-items-center rounded-lg bg-surface-muted">
                    {index === 2 ? <MessageSquare className="h-4 w-4" /> : <Github className="h-4 w-4" />}
                  </div>
                  <div className="flex-1">
                    <div className="text-sm font-medium">{title}</div>
                    <div className="text-xs text-foreground-muted">{detail}</div>
                  </div>
                  <span className="text-xs text-foreground-muted">{count}</span>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <SectionTitle title="Review decision" />
            <div className="p-4">
              <textarea className="h-24 w-full rounded-lg border border-border bg-input p-3 text-sm outline-none" placeholder="Add a comment (optional)..." />
              <div className="mt-3"><ReviewActions /></div>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
