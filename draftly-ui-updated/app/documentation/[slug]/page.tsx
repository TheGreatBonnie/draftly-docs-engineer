import Link from "next/link";
import type { ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  CheckCircle2,
  Clipboard,
  Clock3,
  Code2,
  ExternalLink,
  FileText,
  GitBranch,
  Github,
  Info,
  Link2,
  MoreHorizontal,
  Pencil,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Badge, Button, Card, Progress, Tabs } from "@/components/ui";

const toc = [
  "Introduction",
  "Prerequisites",
  "Register Your Application",
  "Implement the Authorization Flow",
  "Handle the Callback",
  "Refresh Tokens",
  "Best Practices",
  "Troubleshooting",
  "Next Steps",
];

const quality = [
  ["Accuracy", 94],
  ["Completeness", 91],
  ["Groundedness", 89],
  ["Relevance", 93],
] as const;

const activity = [
  { title: "Documentation updated", detail: "Updated OAuth 2.0 flow examples", time: "3 days ago", tone: "blue" },
  { title: "Evaluation completed", detail: "Score: 0.92 (passed)", time: "3 days ago", tone: "green" },
  { title: "PR merged", detail: "Add PKCE support and examples", time: "5 days ago", tone: "violet" },
  { title: "Review approved", detail: "Approved by Alex R.", time: "5 days ago", tone: "green" },
] as const;

const code = `https://auth.authly.dev/oauth/authorize?\nresponse_type=code&\nclient_id=YOUR_CLIENT_ID&\nredirect_uri=https://yourapp.com/callback&\nscope=openid profile email&\ncode_challenge=YOUR_CODE_CHALLENGE&\ncode_challenge_method=S256`;

export default async function DocumentationDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  return (
    <div className="-mt-1">
      <div className="mb-3 flex items-center gap-2 text-sm text-slate-500">
        <Link href="/documentation" className="inline-flex items-center gap-1 hover:text-blue-600">
          <ArrowLeft className="h-3.5 w-3.5" /> Documentation
        </Link>
        <span>/</span><span>Authentication</span><span>/</span>
        <span className="font-medium text-slate-700">OAuth 2.0 Integration</span>
      </div>

      <section className="border-b border-slate-200 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-3xl font-semibold tracking-tight text-slate-950">OAuth 2.0 Integration</h1>
            <p className="mt-1 max-w-4xl text-sm leading-6 text-slate-500">
              Learn how to integrate OAuth 2.0 authentication with Authly using authorization code flow, PKCE, and best practices.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Badge tone="green"><span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-emerald-500"/>Published</Badge>
              <Badge tone="slate">v2.1.0</Badge>
              <Badge tone="slate">Updated 3 days ago</Badge>
              <Badge tone="slate"><GitBranch className="mr-1 h-3 w-3"/>main</Badge>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button className="px-3"><MoreHorizontal className="h-4 w-4"/></Button>
            <Button><Github className="h-4 w-4"/>View on GitHub</Button>
            <Link href={`/documentation/${slug}/edit`}><Button><Pencil className="h-4 w-4"/>Edit</Button></Link>
            <Button primary><Code2 className="h-4 w-4"/>Open in editor</Button>
          </div>
        </div>
        <div className="mt-4">
          <Tabs active="Content" items={["Content","Source","History","Related","Evaluations","Feedback"]}/>
        </div>
      </section>

      <div className="mt-4 grid gap-4 xl:grid-cols-[200px_minmax(0,1fr)_340px]">
        <aside className="hidden xl:block">
          <Card className="sticky top-20 overflow-hidden py-2">
            {toc.map((item, i) => (
              <a
                key={item}
                href={`#section-${i}`}
                className={`flex items-center gap-2 px-4 py-2.5 text-xs transition hover:bg-slate-50 ${i === 0 ? "border-l-2 border-blue-600 bg-blue-50 font-medium text-blue-700" : "text-slate-600"}`}
              >
                {i === 0 ? <FileText className="h-3.5 w-3.5"/> : <span className="text-slate-400">›</span>}
                <span className="truncate">{item}</span>
              </a>
            ))}
          </Card>
        </aside>

        <main className="min-w-0">
          <Card className="p-5 md:p-7">
            <div className="mb-4 flex items-center justify-between gap-3">
              <Badge>Documentation</Badge>
              <button className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-blue-600"><Link2 className="h-3.5 w-3.5"/>Copy link</button>
            </div>
            <article className="prose prose-slate max-w-none">
              <h2 id="section-0" className="scroll-mt-24 text-3xl font-semibold tracking-tight text-slate-950">OAuth 2.0 Integration</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">
                Authly uses OAuth 2.0 to provide secure and seamless authentication for your applications. This guide walks you through integrating OAuth 2.0 using the authorization code flow with PKCE.
              </p>

              <h3 className="mt-6 text-xl font-semibold text-slate-950">Introduction</h3>
              <p className="mt-2 text-sm leading-7 text-slate-600">
                OAuth 2.0 is an industry-standard protocol for authorization. It lets users grant limited access to their Authly account without sharing credentials. Authly recommends the authorization code flow with PKCE for all client applications.
              </p>

              <div className="my-5 flex gap-3 rounded-xl border border-blue-100 bg-blue-50/70 p-4">
                <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-blue-600 text-white"><Info className="h-4 w-4"/></div>
                <div>
                  <h4 className="text-sm font-semibold text-slate-900">Why PKCE?</h4>
                  <p className="mt-1 text-sm leading-6 text-slate-600">PKCE (Proof Key for Code Exchange) adds an extra layer of security and is required for public clients such as web and mobile applications.</p>
                </div>
              </div>

              <h3 id="section-1" className="scroll-mt-24 mt-6 text-xl font-semibold text-slate-950">Prerequisites</h3>
              <p className="mt-2 text-sm text-slate-600">Before you begin, make sure you have:</p>
              <ul className="mt-3 space-y-2 text-sm text-slate-600">
                {["An Authly account","A registered application","Basic familiarity with HTTP requests","A development environment (e.g., Node.js, Python, or your preferred stack)"].map(x => <li key={x} className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-blue-600"/>{x}</li>)}
              </ul>

              <h3 id="section-2" className="scroll-mt-24 mt-7 text-xl font-semibold text-slate-950">Register Your Application</h3>
              <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-6 text-slate-600">
                <li>Go to the <span className="font-medium text-blue-600">Authly Dashboard</span>.</li>
                <li>Create a new OAuth application and add your callback URL.</li>
                <li>Copy the generated client ID and store it in your application configuration.</li>
              </ol>

              <div className="mt-5 overflow-hidden rounded-xl border border-slate-800 bg-[#132038] text-slate-100 shadow-sm">
                <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5 text-xs">
                  <span className="font-medium">Example: Authorization URL</span>
                  <button className="inline-flex items-center gap-1.5 text-slate-300"><Clipboard className="h-3.5 w-3.5"/>Copy code</button>
                </div>
                <pre className="overflow-x-auto p-4 text-[12px] leading-6 text-rose-300"><code>{code}</code></pre>
              </div>

              <h3 id="section-3" className="scroll-mt-24 mt-7 text-xl font-semibold text-slate-950">Implement the Authorization Flow</h3>
              <p className="mt-2 text-sm leading-7 text-slate-600">Redirect users to the authorization URL, validate state, exchange the callback code for tokens, and securely persist only the credentials your application requires.</p>

              <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-start gap-3">
                  <ShieldCheck className="mt-0.5 h-5 w-5 text-emerald-600"/>
                  <div><h4 className="text-sm font-semibold">Security recommendation</h4><p className="mt-1 text-sm leading-6 text-slate-600">Never expose client secrets in browser code. Rotate refresh tokens and revoke credentials when an account or session is compromised.</p></div>
                </div>
              </div>

              <div id="section-4" className="scroll-mt-24 mt-7 border-t border-slate-100 pt-5"><h3 className="text-xl font-semibold">Handle the Callback</h3><p className="mt-2 text-sm leading-7 text-slate-600">Validate the authorization response before exchanging the code for tokens.</p></div>
              <div id="section-5" className="scroll-mt-24 mt-7"><h3 className="text-xl font-semibold">Refresh Tokens</h3><p className="mt-2 text-sm leading-7 text-slate-600">Use refresh tokens to obtain new access tokens without forcing users to sign in again.</p></div>

              <div className="mt-8 flex items-center justify-between border-t border-slate-100 pt-5">
                <Button><ArrowLeft className="h-4 w-4"/>Authentication overview</Button>
                <Button>Token management<ArrowRight className="h-4 w-4"/></Button>
              </div>
            </article>
          </Card>
        </main>

        <aside className="space-y-4">
          <Card className="p-4">
            <div className="flex items-center justify-between"><h3 className="font-semibold">Document status</h3><Badge tone="green"><span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-emerald-500"/>Published</Badge></div>
            <p className="mt-2 text-xs leading-5 text-slate-500">This document is live and available to users.</p>
            <div className="mt-4 space-y-4 text-xs">
              <MetaRow label="Last updated"><div className="flex gap-2"><CalendarDays className="mt-0.5 h-3.5 w-3.5"/><span>Aug 28, 2026 at 10:24 AM<br/><span className="text-slate-500">by Bonnie K.</span></span></div></MetaRow>
              <MetaRow label="Created"><span>Jul 15, 2026</span></MetaRow>
              <MetaRow label="Version"><div><span>v2.1.0</span><div className="mt-1 text-blue-600">View all versions →</div></div></MetaRow>
              <MetaRow label="Source"><div><div className="flex items-center gap-1.5"><Github className="h-3.5 w-3.5"/>authly/docs <ExternalLink className="h-3 w-3"/></div><div className="mt-1 text-slate-500">/authentication/oauth-2.0.md</div><div className="mt-2"><Badge tone="slate"><GitBranch className="mr-1 h-3 w-3"/>main</Badge></div></div></MetaRow>
              <MetaRow label="Tags"><div className="flex flex-wrap gap-1.5">{["authentication","oauth","security","integration","pkce"].map(t=><Badge key={t}>{t}</Badge>)}</div></MetaRow>
              <MetaRow label="Next review"><div className="flex items-center gap-2"><CalendarDays className="h-3.5 w-3.5"/><span>Sep 28, 2026</span><Button className="h-8 px-2 text-xs">Schedule</Button></div></MetaRow>
            </div>
          </Card>

          <Card className="p-4">
            <h3 className="font-semibold">Quality & evaluation</h3>
            <div className="mt-4 grid grid-cols-[112px_1fr] items-center gap-4">
              <div className="relative mx-auto grid h-24 w-24 place-items-center rounded-full" style={{background:"conic-gradient(#10b981 0 92%, #e2e8f0 92% 100%)"}}>
                <div className="grid h-[74px] w-[74px] place-items-center rounded-full bg-white text-center"><div><div className="text-2xl font-semibold">92</div><div className="text-[10px] text-slate-500">Quality score</div></div></div>
              </div>
              <div className="space-y-3">{quality.map(([label,value],i)=><div key={label}><div className="mb-1 flex justify-between text-xs"><span className="text-slate-600">{label}</span><span className="font-medium">0.{value}</span></div><Progress value={value} tone={i===2?"violet":"green"}/></div>)}</div>
            </div>
            <Button className="mt-4 w-full">View evaluations <ArrowRight className="h-4 w-4"/></Button>
          </Card>

          <Card className="p-4">
            <div className="flex items-center justify-between"><h3 className="font-semibold">Recent activity</h3><button className="text-xs font-medium text-blue-600">View all</button></div>
            <div className="relative mt-4 space-y-4 before:absolute before:bottom-2 before:left-[11px] before:top-2 before:w-px before:bg-slate-200">
              {activity.map((a) => {
                const tone = a.tone === "green" ? "bg-emerald-500" : a.tone === "violet" ? "bg-violet-500" : "bg-blue-500";
                return <div key={a.title} className="relative flex gap-3"><div className={`z-10 mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-white ${tone}`}>{a.tone === "green" ? <CheckCircle2 className="h-3.5 w-3.5"/> : <Sparkles className="h-3.5 w-3.5"/>}</div><div className="min-w-0 flex-1"><div className="flex justify-between gap-2"><span className="text-xs font-medium">{a.title}</span><span className="whitespace-nowrap text-[11px] text-slate-400">{a.time}</span></div><p className={`mt-0.5 text-xs ${a.detail.includes("Score") ? "text-emerald-600" : "text-slate-500"}`}>{a.detail}</p></div></div>
              })}
            </div>
          </Card>
        </aside>
      </div>

      <div className="mt-4 flex items-center gap-2 text-xs text-slate-400"><Clock3 className="h-3.5 w-3.5"/>Route: /documentation/{slug}</div>
    </div>
  );
}

function MetaRow({label,children}:{label:string;children:ReactNode}) {
  return <div className="grid grid-cols-[86px_1fr] gap-3"><span className="text-slate-500">{label}</span><div className="min-w-0 text-slate-700">{children}</div></div>
}
