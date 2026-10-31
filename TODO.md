# TODO — engineering backlog

Carry-forward engineering items. Each carries enough context to act on without
re-deriving the reasoning. **Delete items when done** — git history is the archive.

**Item format — operated by `/todo`.** `- [ ] #1 (server, low, founder) headline…`: a stable
`#id`, then AREA (`server` · `site` · `ops`), then PRIORITY (`high` · `med` · `low`),
then optional tags in this order — `founder` (Peter owns it or must say go), `doing` (work has
landed and the item is still open), `blocked: <why or #id>`. A bolded headline of 60 characters
or fewer states the task; one item is one landing. **A section heading and its preamble are
shared context for every item beneath it.**

**next-id: 7.** Ids are never reused, so this counter survives deleting the newest item.

## MVP

Work that ships before sign-ups open (SPEC.md, "Version 2: Milton for anyone"). Use the memo
terminology in SPEC's "Naming: memos" and plain text on security screens and anything an
assistant reads.

- [ ] #2 (server, med) **Try TPS setup with a real assistant.** The functional release starts
      with empty permanent TPS and provides tps_check: available explicit working preferences,
      useful follow-ups, full-draft approval, update_tps_report, then success-only confirmation.
      Use the questionnaire when preferences are unavailable. Memos contain instructions,
      never personal facts. The real-assistant trial remains unperformed and requires Peter's
      later go for any account write; preserve previous versions for comparison/recovery.

## After the MVP

Work Peter moved past the MVP (SPEC.md, "Version 2: Milton for anyone"). The MVP grants every
connected assistant read and write; nothing here blocks the cutover.

- [ ] #1 (server, low) **Make disconnect cut an assistant off at once.** Neon Auth's access
      tokens are EdDSA JWTs valid for one hour and Milton verifies them locally, so disconnecting
      a client on the page does not stop a token already issued. Decided 2026-10-29: record the
      disconnected (user, client_id) in Milton and refuse its MCP requests even while its token
      is valid; it covers every connection sharing that client id, not single devices. Needs the
      page's connected-clients list first. Neon docs: auth/guides/plugins/oauth-provider.

- [ ] #6 (site, low, founder) **Give Milton a Hawaiian shirt on Fridays.** Deferred 2026-10-30:
      Peter rejected the shirt beside the folder and wants to revisit the idea later.
      Keep the ordinary folder. If resumed, Friday follows each visitor's local time zone;
      choose new artwork and check its readability at navigation-icon size first.
