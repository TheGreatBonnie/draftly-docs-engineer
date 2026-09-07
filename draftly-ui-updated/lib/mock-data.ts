export const reviews = [
  { id:"oauth", title:"OAuth authentication guide", ref:"PR #142", description:"Update authentication documentation based on new refresh token implementation.", repo:"Authly", path:"docs/authentication.md", type:"Documentation update", score:94, evals:6, risk:"Low", updated:"12m ago", status:"Pending" },
  { id:"redis", title:"Redis caching guide", ref:"Issue #87", description:"Add caching best practices with Redis based on engineering discussion.", repo:"Authly", path:"docs/redis/caching.md", type:"New document", score:78, evals:5, risk:"Medium", updated:"45m ago", status:"Pending" },
  { id:"limits", title:"API rate limits documentation", ref:"PR #138", description:"Update rate limit section to reflect new tier configuration.", repo:"Authly", path:"docs/api/rate-limits.md", type:"Documentation update", score:65, evals:7, risk:"High", updated:"1h ago", status:"Urgent" },
  { id:"deploy", title:"Deployment guide", ref:"Release v1.2.0", description:"Update deployment steps for Kubernetes configuration.", repo:"Authly", path:"docs/deployment.md", type:"Documentation update", score:96, evals:8, risk:"Low", updated:"3h ago", status:"Approved" },
  { id:"legacy", title:"Legacy auth migration guide", ref:"Issue #65", description:"New migration guide for legacy authentication systems.", repo:"Authly", path:"docs/migration/legacy.md", type:"New document", score:82, evals:6, risk:"Medium", updated:"5h ago", status:"Needs changes" },
];

export const docs = [
  ["OAuth 2.0 authentication guide","Complete guide to OAuth 2.0 implementation with code examples.","Guide","Up to date","2 hours ago"],
  ["API reference","Detailed API reference for all Authly endpoints and parameters.","Reference","Up to date","5 hours ago"],
  ["SDK installation guide","Install and configure the Authly SDKs.","Guide","Needs update","1 day ago"],
  ["Rate limits and quotas","Understand rate limits, quotas and best practices.","Concept","Up to date","2 days ago"],
  ["Deployment with Kubernetes","Deploy Authly on Kubernetes with production best practices.","Tutorial","Up to date","3 days ago"],
  ["User management","Manage users, roles, and permissions.","Guide","Outdated","5 days ago"],
  ["Billing and subscription","Manage billing, plans, and usage.","Guide","Needs update","6 days ago"],
  ["Migration from v1 to v2","Step-by-step migration guide from v1 to v2.","Tutorial","Up to date","1 week ago"],
];

export const workflows = [
  ["PR Documentation","Generate and update documentation from pull requests.","PR opened/updated","12 min ago","Success",true],
  ["Release Notes","Create release notes and update version documentation.","Release published","2 hours ago","Success",true],
  ["Issue Triage & Docs","Analyze issues and create or update documentation.","Issue opened","1 hour ago","Success",true],
  ["Support Knowledge","Turn support conversations into documentation improvements.","New message","3 hours ago","Success",true],
  ["Scheduled Audit","Check for outdated docs and suggest updates.","Daily (2:00 AM)","6 hours ago","Success",true],
  ["Documentation Review","Run evaluations and send for human review.","Post-generation","4 hours ago","Success",true],
  ["Legacy Docs Migration","Migrate and modernize legacy documentation.","Manual trigger","1 day ago","Pending",false],
  ["API Reference Sync","Keep API reference in sync with code changes.","Code changes","3 days ago","Success",true],
];

export const agents = [
  ["Documentation Agent","Generates, updates, and maintains accurate documentation from code changes, releases, and discussions.","documentation, content-generation, markdown","Active","6 skills","12 min ago"],
  ["Research Agent","Finds relevant context from repositories, discussions, and external sources.","research, context-gathering, web-search","Active","5 skills","18 min ago"],
  ["Documentation Reviewer","Reviews generated documentation for accuracy, completeness, and quality.","review, quality, evaluation","Active","4 skills","25 min ago"],
  ["GitHub Intelligence Agent","Monitors PRs, issues, and releases to detect documentation opportunities.","github, code-analysis, event-processing","Active","5 skills","8 min ago"],
  ["Support Agent","Answers developer questions from Slack, Discord, and GitHub issues using your knowledge base.","support, qa, conversation","Active","6 skills","15 min ago"],
  ["Memory Curator Agent","Manages long-term memory, knowledge organization, and context enrichment.","memory, knowledge-graph, embeddings","Active","5 skills","32 min ago"],
  ["Evaluation Agent","Runs evaluations using Strands Eval SDK and tracks quality metrics.","evaluation, testing, metrics","Active","4 skills","20 min ago"],
  ["Delivery Agent","Publishes approved documentation changes and creates PRs or commits.","deployment, publishing, automation","Idle","4 skills","3 hours ago"],
  ["Scheduler Agent","Handles scheduled jobs, periodic audits, and recurring documentation tasks.","scheduling, automation, maintenance","Idle","3 skills","6 hours ago"],
];

export const integrations = ["GitHub","Slack","Discord","Notion","GitLab","Jira","Confluence","Linear","Google Drive","Microsoft Teams","SharePoint","Zendesk","Intercom","Sentry","Datadog","Custom Webhook"];

export const evaluationRuns = [
  {id:"run_01H8Z3",name:"PR #142 – OAuth authentication",dataset:"documentation",cases:12,passed:11,failed:1,score:92,status:"Completed",started:"Sep 5, 2026, 10:24 AM",duration:"2m 14s"},
  {id:"run_01H7Y1",name:"Release v1.2.0 notes",dataset:"release_notes",cases:10,passed:9,failed:1,score:88,status:"Completed",started:"Sep 4, 2026, 3:12 PM",duration:"1m 58s"},
  {id:"run_01H6K9",name:"Redis caching guide",dataset:"documentation",cases:14,passed:14,failed:0,score:96,status:"Completed",started:"Sep 4, 2026, 9:06 AM",duration:"2m 41s"},
];
export const evalCases = [
  {id:"oauth-expected-contains",case:"oauth-authentication-add",metric:"Expected content",score:100,threshold:60,status:"Passed",reason:"All expected OAuth and refresh-token concepts are present."},
  {id:"oauth-tools",case:"oauth-authentication-add",metric:"Expected tools",score:100,threshold:100,status:"Passed",reason:"Repository and documentation retrieval tools were used."},
  {id:"oauth-grounding",case:"oauth-authentication-add",metric:"Groundedness",score:71,threshold:80,status:"Failed",reason:"One token rotation claim is not directly supported by retrieved source context."},
  {id:"oauth-quality",case:"oauth-authentication-add",metric:"Documentation quality",score:96,threshold:80,status:"Passed",reason:"The output is readable, structured, and developer-focused."},
];
export const activityItems = [
 {id:"evt-pr-142",title:"New pull request opened",detail:"PR #142 Add OAuth 2.0 support",source:"GitHub",type:"Repository",time:"10:24 AM",icon:"github"},
 {id:"evt-doc-oauth",title:"Documentation updated",detail:"Updated authentication guide with OAuth 2.0 examples",source:"Documentation",type:"Document change",time:"10:18 AM",icon:"file"},
 {id:"evt-workflow-142",title:"Workflow completed",detail:"PR Documentation workflow finished successfully",source:"Workflow",type:"Success",time:"09:52 AM",icon:"workflow"},
 {id:"evt-support-rotate",title:"New support question",detail:"How do I rotate API keys without downtime?",source:"Slack",type:"Needs review",time:"09:41 AM",icon:"message"},
];
export const integrationDetails: Record<string,{name:string;description:string;status:string;icon:string;scopes:string[];events:string[];lastSync:string}> = {
 github:{name:"GitHub",description:"Monitor pull requests, issues, releases, and repository changes.",status:"Connected",icon:"github",scopes:["authly/api","authly/sdk","authly/docs"],events:["Pull requests","Releases","Issues","Pushes"],lastSync:"12 min ago"},
 slack:{name:"Slack",description:"Ingest support and engineering conversations from selected channels.",status:"Connected",icon:"slack",scopes:["#engineering","#support","#product"],events:["New messages","Threads","Reactions"],lastSync:"28 min ago"},
 discord:{name:"Discord",description:"Monitor community support and developer conversations.",status:"Connected",icon:"message",scopes:["#help","#developers"],events:["New messages","Threads"],lastSync:"1 hour ago"},
 notion:{name:"Notion",description:"Sync product documentation, wikis, and knowledge bases.",status:"Connected",icon:"file",scopes:["Product Docs","Engineering Wiki"],events:["Page changes","New pages"],lastSync:"3 hours ago"},
};
export const knowledgeTopics = [
 {name:"Authentication",documents:58,concepts:162,discussions:23,changes:12},
 {name:"API Reference",documents:42,concepts:118,discussions:14,changes:18},
 {name:"Deployment",documents:36,concepts:84,discussions:11,changes:9},
 {name:"User Management",documents:28,concepts:72,discussions:8,changes:6},
 {name:"SDKs",documents:24,concepts:66,discussions:16,changes:13},
];
export const workflowSteps = [
 {name:"GitHub event received",agent:"GitHub Intelligence Agent",status:"Completed",duration:"2s"},
 {name:"Repository context loaded",agent:"Research Agent",status:"Completed",duration:"5s"},
 {name:"Documentation patch generated",agent:"Documentation Agent",status:"Completed",duration:"48s"},
 {name:"Quality evaluation",agent:"Evaluation Agent",status:"Completed",duration:"13s"},
 {name:"Human review created",agent:"Documentation Reviewer",status:"Completed",duration:"4s"},
];
