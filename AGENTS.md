<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:esblu-gdpr-ai-access -->
# GDPR — AI dev tool access (Anthropic / Claude / Cowork)

Anthropic is a declared sub-processor (DPA 1.3, Annex 3) **only** for development, maintenance, technical audit,
diagnostics and approved service interventions. Binding rules: `docs/ai-dev-tool-access-policy.md`.
Short version: staging/synthetic data first; production only when necessary, minimum scope, aggregates/metadata
before rows; never dump tables, never copy production personal data into prompts, docs, commits, issues or logs;
no secrets in outputs; every production access is recorded in `docs/ops/service-intervention-log.md`.
<!-- END:esblu-gdpr-ai-access -->
