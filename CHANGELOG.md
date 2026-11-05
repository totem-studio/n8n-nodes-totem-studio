# Changelog

## 1.0.0 — API v1

- The API action and Events polling trigger share one reusable API-key credential
  and the same maintained public API implementation used internally.
- Includes current-source CRM, messaging, calendar, Library, Catalog, knowledge
  and lifecycle events with explicit content grants and bounded operation
  observation. Write receipts do not imply completed provider effects.
- Sends explicit empty JSON request bodies unchanged for actions whose public
  contract requires `{}`.
- Public TypeScript source snapshots are available at
  `https://github.com/totem-studio/n8n-nodes-totem-studio`; the standalone build
  and provenance workflow include no private Git history.
- Saved node and credential identities retain version 1. npm publication,
  production deployment and n8n Cloud listing are separate release outcomes.

## 1.0.0-rc.1 — unpublished candidate

- The API action and Events polling trigger share one reusable API-key credential
  and the same maintained implementation used internally.
- Adds the expanded API operations, explicit bounded operation observation and
  closed write receipts without implicitly repeating business effects.
- Adds a standalone public TypeScript source export and a reproducible public
  repository build and provenance workflow. The public repository and npm
  trusted publisher have not been created or configured by this change.
- Stable 1.0, production cutover and verified n8n Cloud approval remain pending
  their actual acceptance checks. Saved node and credential identities retain
  version 1.
