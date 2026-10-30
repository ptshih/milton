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

Work that ships before sign-ups open (SPEC.md, "Version 2: Milton for anyone"). The voice is the
vibe-coding and cooking theme in SPEC's "Naming: recipes": jokes on success and failure moments,
plain text on security screens and anything an assistant reads.

- [ ] #2 (server, med) **Draft a new user's vibes from a vibe check.** An empty account is the
      MVP's biggest first-session risk. Decided 2026-10-30: the person's own assistant runs it,
      Milton makes no model call and has no page form. While `vibes` is still the template, the
      standing instruction tells the assistant to offer a vibe check; a `vibe_check` tool returns
      five questions (short or thorough; bullets or prose; how blunt: mild, medium, hot; what to
      check before acting; what annoys you in an AI reply) plus a quick lightning round of
      yes/no style calls ("Do you love em dashes?", Oxford comma, emoji, "Great question!"
      openers); the em dash is why Peter built Milton, an optional "paste your ChatGPT or
      Claude memory export" step, and a drafting guide. The assistant shows the draft, saves it
      with update_recipe on a yes, and ends with "We're cooking now!". Recipes are instructions,
      never facts about the person (project rule). The write tools it needs shipped 2026-10-30. Test plan (Peter, 2026-10-30): on Peter's own
      account, save vibes back to the template as a new version, run the check in one assistant,
      compare with the previous version and revert if worse; nothing is deleted.

## After the MVP

Work Peter moved past the MVP (SPEC.md, "Version 2: Milton for anyone"). The MVP grants every
connected assistant read and write; nothing here blocks the cutover.

- [ ] #1 (server, low) **Make disconnect cut an assistant off at once.** Neon Auth's access
      tokens are EdDSA JWTs valid for one hour and Milton verifies them locally, so disconnecting
      a client on the page does not stop a token already issued. Decided 2026-10-29: record the
      disconnected (user, client_id) in Milton and refuse its MCP requests even while its token
      is valid; it covers every connection sharing that client id, not single devices. Needs the
      page's connected-clients list first. Neon docs: auth/guides/plugins/oauth-provider.

- [ ] #3 (server, low) **Add a taste_test tool that judges drafts by recipes.** Decided 2026-10-29:
      the assistant judges, Milton supplies the rules. `taste_test(draft, recipe?)` returns the
      relevant recipes and a short judging instruction (check each rule, quote the breaking line,
      verdict on the scale Raw / Needs salt / Solid / Chef's kiss / We're cooked); Milton makes no
      model call. Plus one line in the standing instruction asking assistants to taste-test their
      own drafts before showing them. It judges drafts against rules, never the person. A
      Milton-side judge on the page (model cost, abuse limits) is deliberately later. Ships after
      the write tools.

- [ ] #6 (site, low) **Give Milton a Hawaiian shirt on Fridays.** Peter’s idea, 2026-10-30:
      the Milton logo/icon wears a Hawaiian shirt every Friday, as an Office Space nod.
      Before implementation, choose which time zone defines Friday and how the shirt reads
      at small icon sizes. The ordinary mark returns on other days.
