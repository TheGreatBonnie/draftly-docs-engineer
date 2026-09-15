In Draftly, **installing the GitHub App on Authly is only the access/authorization step**. It does not by itself mean Authly's existing documentation has been imported into Draftly.

The clean production flow should be:

```text
GitHub App installed on Authly
             │
             ▼
      GitHub installation
             │
             ▼
      Select Authly repo
             │
             ▼
      "Sync documentation"
             │
             ▼
       GitHub ingestion
             │
             ▼
      Documentation scanner
             │
             ▼
     Existing docs discovered
             │
             ▼
      Normalize + chunk
             │
             ├──────────────┐
             ▼              ▼
   Document metadata    Embeddings
             │              │
             └──────┬───────┘
                    ▼
            Draftly memory
                    │
                    ▼
           Documentation index
```

Your README already defines the relevant pieces: GitHub events enter through webhook routes, the dispatcher starts workflows, agents interact with the memory store, and Draftly has a documentation indexer plus repository tools. fileciteturn0file0L139-L174

## 1. What "sync existing docs" should mean

For Authly, imagine the repository currently looks like:

```text
authly/
├── README.md
├── CHANGELOG.md
├── CONTRIBUTING.md
├── docs/
│   ├── getting-started.md
│   ├── authentication.md
│   ├── oauth.md
│   ├── api-keys.md
│   ├── rbac.md
│   └── webhooks.md
├── examples/
├── src/
└── ...
```

Draftly should **not immediately rewrite these files**.

The initial sync should be an **ingestion/indexing operation**:

> "Take the documentation that already exists in Authly, understand its structure, store it in Draftly's documentation/memory system, and establish a baseline against which future repository changes can be evaluated."

That's a very important distinction.

---

# 2. The first step: identify the GitHub installation

When the GitHub App is installed, GitHub gives the installation an `installation_id`. For webhook events, GitHub includes the installation ID in the webhook payload; Draftly can then generate an installation access token and use it against the GitHub API. GitHub installation access tokens expire after one hour. ([GitHub Docs][1])

Conceptually:

```text
GitHub
  │
  │ installation
  ▼
installation_id
  │
  ▼
Draftly
  │
  ├── authenticate installation
  │
  └── obtain installation access token
```

Draftly should store something like:

```text
github_installation
──────────────────────
id
installation_id
github_account_id
account_login
repository_selection
created_at
updated_at
```

**Do not store the installation access token permanently.**

Generate it when needed and cache it only for its valid lifetime.

---

# 3. Discover the Authly repository

Once the installation is known, Draftly asks GitHub:

```text
What repositories can this installation access?
```

GitHub provides an installation endpoint specifically for listing repositories accessible to a GitHub App installation. ([GitHub Docs][2])

The result might be:

```text
Available repositories

☑ authly
☐ authly-examples
☐ authly-docs
```

The user selects:

```text
Authly
```

Draftly then creates its internal repository connection:

```text
github_repository
────────────────────────
id
organization_id
installation_id
github_repository_id
owner = "authly"
name = "authly"
default_branch = "main"
enabled = true
```

This is the point where Draftly knows:

> "This Authly repository belongs to this Draftly organization."

---

# 4. Then provide a "Sync documentation" action

Your Draftly UI could have:

```text
Authly
GitHub

● Connected

Repository
authly/authly

Documentation

Last synced:
Never

[ Sync documentation ]

Documentation paths
☑ /README.md
☑ /docs/**
☑ /CHANGELOG.md
☐ /examples/**
```

I'd make the first sync configurable.

For example:

### Documentation sources

```text
README.md
docs/**
CHANGELOG.md
CONTRIBUTING.md
```

### Exclusions

```text
node_modules/**
dist/**
build/**
vendor/**
.git/**
```

The user should be able to override these later.

---

# 5. The sync should create a job

Don't perform the whole repository sync inside the HTTP request.

Your existing architecture already has workers for long-running jobs, including an indexing worker that pulls repository content and refreshes the documentation index.

So:

```text
POST /api/documentation/sync
             │
             ▼
        Create Job
             │
             ▼
       Return 202
             │
             ▼
      indexing_worker
             │
             ▼
      Sync Authly docs
```

The API response could be:

```json
{
  "job_id": "doc_sync_123",
  "repository": "authly/authly",
  "status": "queued"
}
```

---

# 6. The indexing worker gets the repository tree

The worker uses the GitHub App installation credentials to inspect Authly.

Conceptually:

```text
GitHub API
    │
    ├── repository metadata
    ├── default branch
    ├── tree
    └── file contents
```

It should first identify candidate documentation files.

For example:

```text
README.md                 → documentation
docs/getting-started.md   → documentation
docs/oauth.md             → documentation
docs/rbac.md              → documentation
src/auth.py               → source code
tests/test_oauth.py       → test
```

This classification should be deterministic initially.

---

# 7. Don't have the LLM discover every file

This is an important production design choice.

Don't do:

```text
Get 5,000 files
      ↓
LLM
      ↓
"Which are docs?"
```

Instead use repository rules:

```text
README.md
docs/**
documentation/**
*.md
*.mdx
```

Then optionally allow an agent to classify ambiguous files.

For Authly:

```text
docs/**/*.md
README.md
CHANGELOG.md
CONTRIBUTING.md
```

could be the initial default.

---

# 8. Store the raw source document

Each document should have a canonical record.

For example:

```text
document
────────────────────────────
id
organization_id
repository_id

path
branch
commit_sha

title
mime_type

source = github

source_url

content_hash

last_modified

status

created_at
updated_at
```

For:

```text
authly/docs/oauth.md
```

you might have:

```text
path:
docs/oauth.md

source:
github

repository:
authly/authly

commit:
a83f92c...

content_hash:
sha256:...

source_url:
GitHub blob URL
```

The **commit SHA + path + content hash** combination is particularly useful.

---

# 9. Then parse the Markdown

Suppose:

```text
docs/oauth.md
```

contains:

```markdown
# OAuth Authentication

Authly supports OAuth 2.0...

## Authorization Code Flow

...

## PKCE

...
```

Don't embed the entire Markdown file as one giant chunk.

Parse its structure:

```text
oauth.md
│
├── OAuth Authentication
│
├── Authorization Code Flow
│
└── PKCE
```

Then create structured chunks.

---

# 10. Chunk according to documentation structure

For example:

```text
Document
  │
  ├── H1
  │    ├── H2
  │    │    ├── H3
  │    │    └── H3
  │    └── H2
  │
  └── H1
```

The chunk metadata should retain:

```text
document_id
chunk_id
path
heading
heading_path
content
start_line
end_line
commit_sha
```

So a retrieved chunk can say:

```text
Authly
docs/oauth.md
OAuth Authentication → PKCE
```

rather than just returning anonymous text.

---

# 11. Generate embeddings

Your Draftly structure already has:

```text
memory/
├── embeddings.py
├── retrieval.py
├── ranking.py
├── repository.py
└── service.py
```

and the factory already provides an `EmbeddingRouter`. fileciteturn0file1L716-L776

So:

```text
Markdown
   │
   ▼
Parser
   │
   ▼
Chunks
   │
   ▼
EmbeddingRouter
   │
   ▼
Vector embeddings
   │
   ▼
PostgreSQL vector store
```

This is what allows a later support question such as:

> "How do I configure PKCE in Authly?"

to retrieve:

```text
docs/oauth.md
→ OAuth Authentication
→ PKCE section
```

instead of making the support agent search the entire repository.

---

# 12. Create the initial documentation baseline

This is where Draftly becomes more interesting than a generic RAG system.

After ingestion, Draftly should create a **documentation baseline**.

For Authly:

```text
Authly documentation baseline
Commit: a83f92c

Documents:
18

Sections:
94

Indexed chunks:
412

Documentation paths:
docs/**
README.md
CHANGELOG.md

Last synced:
2026-08-22 01:12
```

Now Draftly has a known state:

```text
Authly @ commit A
       │
       ▼
Documentation baseline
```

---

# 13. Then connect source code to documentation

This is the next important step.

You don't want Draftly's knowledge base to contain only:

```text
docs/oauth.md
```

You want relationships like:

```text
docs/oauth.md
      │
      ├── references → src/oauth/service.py
      ├── references → src/oauth/pkce.py
      └── references → tests/test_pkce.py
```

Then when a future PR changes:

```text
src/oauth/pkce.py
```

Draftly can reason:

```text
Code changed
     ↓
Related documentation?
     ↓
docs/oauth.md
     ↓
Potential documentation impact
```

That aligns directly with Draftly's GitHub change-analysis feature described in your README.

---

# 14. How the initial sync should use your agents

I would **not** make the entire sync one giant agent call.

Instead:

```text
GitHub Sync
     │
     ▼
Repository Indexer
     │
     ├── deterministic file discovery
     ├── content retrieval
     ├── hashing
     ├── parsing
     └── embedding
             │
             ▼
       Documentation Analyzer
             │
             ├── classify docs
             ├── detect structure
             ├── identify links
             ├── identify code references
             └── detect metadata
```

Your existing documentation agents include analyzer, researcher, writer, reviewer and auditor.

For the **initial sync**, primarily use:

```text
documentation_analyzer
```

and perhaps:

```text
memory_curator
```

Do **not** invoke:

```text
documentation_writer
```

during the initial import.

The purpose is to establish the current state, not rewrite it.

---

# 15. Then run a documentation audit

Once Authly's docs are indexed:

```text
Sync
 ↓
Index
 ↓
Audit
```

The auditor can identify:

```text
✓ documented
⚠ possibly stale
⚠ missing documentation
⚠ broken links
⚠ orphaned documentation
⚠ duplicate content
```

For example:

```text
Authly Documentation Audit

✓ OAuth documentation
✓ API key documentation
✓ RBAC documentation

⚠ PKCE implementation changed recently
⚠ webhook configuration undocumented
⚠ /docs/legacy-api.md references removed API
```

This is where Draftly starts providing value immediately after installation.

---

# 16. But don't automatically modify Authly

The initial workflow should be:

```text
Sync
 ↓
Index
 ↓
Audit
 ↓
Findings
 ↓
Human review
```

Not:

```text
Sync
 ↓
LLM
 ↓
rewrite 30 files
```

Your architecture explicitly has a human review gate before anything reaches users.

So Draftly might produce:

```text
Documentation findings

3 issues detected

1. OAuth PKCE documentation may be stale
2. New webhook configuration is undocumented
3. API key rotation example is outdated

[ Review findings ]
```

---

# 17. After the initial sync, GitHub webhooks take over

This is where "sync" changes into continuous synchronization.

The initial state is:

```text
Authly repository
       │
       │ initial sync
       ▼
Draftly baseline
```

After that:

```text
Authly
  │
  │ PR opened
  ▼
GitHub webhook
  │
  ▼
Draftly event dispatcher
  │
  ▼
GitHub PR workflow
```

Your README already describes GitHub PRs, issues and releases entering through webhooks and being routed through workflow graphs.

---

# 18. Example: Authly changes PKCE

Imagine Authly developer merges:

```text
src/auth/pkce.py
```

and changes the PKCE behavior.

GitHub sends:

```text
pull_request
```

Draftly receives:

```text
GitHub
 ↓
Webhook route
 ↓
Event dispatcher
 ↓
GitHub PR workflow
```

Then:

```text
PR Analyzer
     ↓
detect code changes
     ↓
documentation impact analysis
     ↓
Memory retrieval
     ↓
docs/oauth.md
     ↓
Documentation Engineer
```

The documentation engineer now has both:

```text
Current repository code
+
Existing Authly documentation
```

This is much better than generating documentation from scratch.

---

# 19. Draftly should distinguish three document states

I recommend:

```text
SOURCE
```

The document exactly as it exists in GitHub.

```text
INDEXED
```

The document has been parsed, chunked and embedded.

```text
PROPOSED
```

Draftly has generated a modification.

Then:

```text
SOURCE
  ↓
INDEXED
  ↓
AUDIT
  ↓
PROPOSED
  ↓
HUMAN REVIEW
  ↓
PUBLISHED
```

This prevents generated content from accidentally replacing the source of truth.

---

# 20. The Authly onboarding flow

Putting everything together, I'd make the actual Draftly UX:

```text
┌──────────────────────────────────────────────┐
│ Connect GitHub                               │
│                                              │
│ ✓ GitHub App installed                      │
│                                              │
│ Installation: Authly                         │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│ Select repository                            │
│                                              │
│ ● authly/authly                              │
│                                              │
│              [ Connect Repository ]          │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│ Import existing documentation                │
│                                              │
│ Documentation paths:                         │
│                                              │
│ ☑ README.md                                  │
│ ☑ docs/**                                    │
│ ☑ CHANGELOG.md                               │
│ ☑ CONTRIBUTING.md                            │
│                                              │
│ [ Start initial sync ]                       │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
                 Syncing Authly
                       │
             ┌─────────┼─────────┐
             ▼         ▼         ▼
          Discover   Parse    Embed
           files     docs     chunks
             │         │         │
             └─────────┼─────────┘
                       ▼
                 Documentation
                    baseline
                       │
                       ▼
                 Run initial audit
                       │
                       ▼
              Documentation health
```

---

# 21. What I'd add to your Draftly project

Your current structure already has most of the necessary building blocks.

I'd specifically make the documentation ingestion path:

```text
src/draftly/
│
├── documentation/
│   ├── indexer.py
│   ├── repositories/
│   │   ├── github_repository.py
│   │   └── ...
│   ├── parser.py
│   ├── chunker.py
│   ├── analyzer.py
│   ├── baseline.py
│   ├── sync.py
│   └── models.py
│
├── memory/
│   ├── embeddings.py
│   ├── retrieval.py
│   ├── ranking.py
│   └── service.py
│
├── integrations/
│   └── github/
│       ├── client.py
│       ├── webhooks.py
│       └── app_auth.py
│
├── workflows/
│   └── documentation/
│       ├── sync.py
│       └── audit.py
│
└── persistence/
    └── repositories/
        ├── documents.py
        ├── documentation_sync.py
        └── github.py
```

Your README already specifies GitHub integration components, a documentation indexer, generator/updater/validator, and documentation workflows, so this is largely an implementation of the architecture you already defined.

---

# 22. The critical distinction: sync vs. documentation generation

For Authly, think of Draftly as having **two separate operations**:

### Initial sync

```text
GitHub → Draftly
```

It answers:

> "What documentation does Authly currently have?"

### Documentation workflow

```text
GitHub change → Draftly → proposed documentation change → review → GitHub
```

It answers:

> "What should change in Authly's documentation because the product changed?"

That separation is essential.

---

## The complete Authly lifecycle

```text
                  AUTHLY
                    │
                    │ GitHub App
                    ▼
             ┌───────────────┐
             │ GitHub App    │
             │ Installation  │
             └───────┬───────┘
                     │
                     ▼
              Repository Link
                     │
                     ▼
            ┌─────────────────┐
            │ Initial Sync    │
            └────────┬────────┘
                     │
          ┌──────────┼──────────┐
          ▼          ▼          ▼
       Discover    Parse      Hash
        files       docs      content
          │          │          │
          └──────────┼──────────┘
                     ▼
              Chunk documents
                     │
                     ▼
               Generate vectors
                     │
                     ▼
             Draftly Memory/Index
                     │
                     ▼
             Documentation Baseline
                     │
                     ▼
              Initial Audit
                     │
                     ▼
             ┌──────────────┐
             │ Human Review │
             └──────────────┘
                     │
                     ▼
               ─── LIVE ───
                     │
          ┌──────────┴───────────┐
          │                      │
       GitHub PR             GitHub Issue
          │                      │
          ▼                      ▼
     Documentation          Support/Issue
       workflow              workflow
          │                      │
          └──────────┬───────────┘
                     ▼
              Draftly Memory
                     │
                     ▼
            Documentation update
                     │
                     ▼
                Review Gate
                     │
                     ▼
              GitHub PR / comment
```

This is the model I'd use for your **Authly → Draftly demo**: **connect repository → import existing docs → establish baseline → audit → continuously watch future GitHub changes**. It demonstrates much more of Draftly's actual value than simply showing an agent generate a README from a repository.

[1]: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation?utm_source=chatgpt.com "Authenticating as a GitHub App installation - GitHub Docs"
[2]: https://docs.github.com/en/rest/apps/installations?utm_source=chatgpt.com "REST API endpoints for GitHub App installations - GitHub Docs"
