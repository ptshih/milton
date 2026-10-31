import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { StoreDatabase, StoreSession } from "./database";
import { databaseFailure } from "./database";
import { StoreError } from "./errors";
import { readLimits, utf8Bytes } from "./index";
import type { CompilerInput, MemoCompiler } from "../compiler";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = z
  .string()
  .max(32768)
  .refine((v) => !v.includes("\0") && utf8Bytes(v) <= 32768);
export const saveMemoInput = z.strictObject({
  text: text.refine((v) => v.trim().length > 0),
  request_id: z.uuid(),
  expected_version: z.string().regex(/^[a-f0-9]{64}$/),
});
export type SaveMemoInput = z.infer<typeof saveMemoInput>;
export const proposalSchema = z.strictObject({
  decision: z.enum(["apply", "noop", "clarify"]),
  memos: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(256).nullable(),
        description: z
          .string()
          .min(1)
          .max(500)
          .refine((v) => !/[\r\n\0]/.test(v) && utf8Bytes(v) <= 500),
        text: text.refine((v) => v.trim().length > 0),
      }),
    )
    .max(100),
  tps: text,
  message: z
    .string()
    .max(500)
    .refine((v) => !v.includes("\0")),
});
export type MemoProposal = z.infer<typeof proposalSchema>;
const outcomeSchema = z.object({
  status: z.enum([
    "saved",
    "unchanged",
    "needs_clarification",
    "conflict",
    "in_progress",
    "failed",
  ]),
  request_id: z.string(),
  version: z.string().optional(),
  question: z.string().optional(),
  error: z.string().optional(),
});
export type SaveOutcome = z.infer<typeof outcomeSchema>;
export type CompiledReport = {
  text: string;
  version: string;
  is_empty: boolean;
};
type Head = {
  id: string;
  name: string;
  version: number;
  description: string;
  body: string;
  archived: boolean;
};
type Report = { revision: number; body: string; source_hash: string };
type Receipt = {
  input_hash: string;
  completed: boolean;
  live: boolean;
  result_json: unknown;
};
const deadlineSeconds = 40;

export function compiledMemos(
  db: StoreDatabase,
  userId: string,
  compiler?: MemoCompiler,
  actor?: { issuer: string; clientId: string },
) {
  const version = (revision: number) => hash(["tps", userId, revision]);
  async function lock(tx: StoreSession) {
    if (
      !(
        await tx.query(
          sql`SELECT id FROM users WHERE id=${userId} AND status='active' FOR UPDATE`,
        )
      ).length
    )
      throw new StoreError(
        "account_unavailable",
        "This Milton account is unavailable.",
        403,
      );
  }
  async function snapshot(tx: StoreSession) {
    // All heads, including archive state, in one tenant-locked snapshot. Never page this input.
    const heads =
      await tx.query<Head>(sql`SELECT m.id,m.name,v.version,v.description,v.body,v.archived FROM memos m
      JOIN LATERAL (SELECT version,description,body,archived FROM memo_versions WHERE user_id=m.user_id AND memo_id=m.id ORDER BY version DESC LIMIT 1) v ON true
      WHERE m.user_id=${userId} ORDER BY m.id`);
    const report = (
      await tx.query<Report>(
        sql`SELECT revision,body,source_hash FROM tps_reports WHERE user_id=${userId}`,
      )
    )[0];
    const fingerprint = hash(heads.map((h) => [h.id, h.version, h.archived]));
    const active = heads.filter((h) => !h.archived && h.body.trim());
    const ready = report
      ? report.source_hash === fingerprint
      : active.length === 0;
    return {
      heads,
      report,
      fingerprint,
      active,
      ready,
      version: version(report?.revision ?? 0),
    };
  }
  async function receipt(tx: StoreSession, id: string) {
    return (
      await tx.query<Receipt>(
        sql`SELECT input_hash,completed,deadline>clock_timestamp() AS live,result_json FROM save_requests WHERE user_id=${userId} AND request_id=${id}`,
      )
    )[0];
  }
  async function complete(tx: StoreSession, result: SaveOutcome) {
    await tx.query(
      sql`UPDATE save_requests SET completed=true,result_json=${JSON.stringify(result)}::jsonb WHERE user_id=${userId} AND request_id=${result.request_id} AND NOT completed`,
    );
    return result;
  }
  return {
    async getTpsReport(): Promise<CompiledReport> {
      return db
        .transaction(async (tx) => {
          await lock(tx);
          const current = await snapshot(tx);
          if (!current.ready)
            throw new StoreError(
              "tps_report_unavailable",
              "TPS Report has not been compiled from the current memos. Submit an instruction with save_memo to compile them together.",
              409,
              { version: current.version },
            );
          const body = current.report?.body ?? "";
          return {
            text: body,
            version: current.version,
            is_empty: body === "",
          };
        })
        .catch((error) => {
          throw databaseFailure(error);
        });
    },
    async saveMemo(raw: SaveMemoInput): Promise<SaveOutcome> {
      const parsed = saveMemoInput.safeParse(raw);
      if (!parsed.success)
        throw new StoreError(
          "invalid_input",
          "Supply instruction text, a request UUID, and the report version.",
          400,
        );
      if (!actor)
        throw new StoreError(
          "assistant_required",
          "Save memos through your connected assistant.",
          403,
        );
      const input = parsed.data;
      const inputHash = hash(input);
      const result = (
        status: SaveOutcome["status"],
        rest: Partial<SaveOutcome> = {},
      ): SaveOutcome => ({ status, request_id: input.request_id, ...rest });
      const claim = await db
        .transaction(async (tx) => {
          // One short shared budget lock; never hold it (or the account lock) over the model call.
          await tx.query(
            sql`SELECT singleton FROM store_config WHERE singleton=1 FOR UPDATE`,
          );
          await lock(tx);
          const existing = await receipt(tx, input.request_id);
          if (existing) {
            if (existing.input_hash !== inputHash)
              throw new StoreError(
                "request_id_reused",
                "This request ID belongs to different input. Reuse the exact original request to recover its result.",
                409,
              );
            if (existing.completed)
              return { outcome: outcomeSchema.parse(existing.result_json) };
            if (existing.live) return { outcome: result("in_progress") };
            return {
              outcome: await complete(
                tx,
                result("failed", { error: "request_expired" }),
              ),
            };
          }
          const current = await snapshot(tx);
          if (input.expected_version !== current.version)
            return {
              outcome: result("conflict", { version: current.version }),
            };
          if (!compiler)
            throw new StoreError(
              "compiler_unavailable",
              "Milton's memo compiler is not configured. Your memos have not changed.",
              503,
            );
          for (const n of [
            compiler.reserveMicros,
            compiler.accountBudgetMicros,
            compiler.globalBudgetMicros,
          ])
            if (!Number.isSafeInteger(n) || n <= 0)
              throw new StoreError(
                "configuration",
                "Milton's model budget is invalid.",
                503,
              );
          const limits = await readLimits(tx);
          if (utf8Bytes(input.text) > limits.body_bytes)
            throw new StoreError(
              "memo_body_limit",
              "The submitted memo is too large.",
              422,
            );
          const spent = (
            await tx.query<{ account: number; total: number }>(sql`SELECT
          coalesce(sum(reserved_micros) FILTER (WHERE user_id=${userId}),0)::float8 AS account,
          coalesce(sum(reserved_micros),0)::float8 AS total FROM save_requests
          WHERE created_at >= ((clock_timestamp() AT TIME ZONE 'UTC')::date::timestamp AT TIME ZONE 'UTC')`)
          )[0]!;
          if (
            spent.account + compiler.reserveMicros >
              compiler.accountBudgetMicros ||
            spent.total + compiler.reserveMicros > compiler.globalBudgetMicros
          )
            throw new StoreError(
              "model_budget_reached",
              "Milton's daily model budget has been reached. Your memos have not changed.",
              429,
            );
          await tx.query(sql`INSERT INTO save_requests(user_id,request_id,input_hash,source_hash,reserved_micros,deadline)
          VALUES (${userId},${input.request_id},${inputHash},${current.fingerprint},${compiler.reserveMicros},clock_timestamp()+${deadlineSeconds}*interval '1 second')`);
          const compilation: CompilerInput = {
            memos: current.active.map((h) => ({
              id: h.id,
              description: h.description,
              text: h.body,
            })),
            text: input.text,
            needsCompilation: !current.ready,
          };
          return { current, compilation };
        })
        .catch((error) => {
          throw databaseFailure(error);
        });
      if (claim.outcome) return claim.outcome;
      try {
        const signal = AbortSignal.timeout(35000);
        const output = await new Promise<unknown>((resolve, reject) => {
          const abort = () =>
            reject(
              new StoreError(
                "compiler_timeout",
                "The model did not finish in time.",
                503,
              ),
            );
          signal.addEventListener("abort", abort, { once: true });
          Promise.resolve()
            .then(() => compiler!.compile(claim.compilation, signal))
            .then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", abort));
        });
        signal.throwIfAborted();
        const checked = proposalSchema.safeParse(output);
        if (!checked.success)
          throw new StoreError(
            "compiler_output_invalid",
            "The model returned an invalid proposal.",
            503,
          );
        const proposal = checked.data;
        if (
          proposal.decision !== "apply" &&
          (proposal.memos.length || proposal.tps !== "")
        )
          throw new StoreError(
            "compiler_output_invalid",
            "A no-change result included changes.",
            503,
          );
        return await db.transaction(async (tx) => {
          await lock(tx);
          const pending = await receipt(tx, input.request_id);
          if (!pending || pending.input_hash !== inputHash)
            throw new StoreError(
              "request_unavailable",
              "The save request is unavailable.",
              503,
            );
          if (pending.completed)
            return outcomeSchema.parse(pending.result_json);
          if (!pending.live)
            return complete(tx, result("failed", { error: "request_expired" }));
          const current = await snapshot(tx);
          if (
            current.fingerprint !== claim.current.fingerprint ||
            current.version !== input.expected_version
          )
            return complete(
              tx,
              result("conflict", { version: current.version }),
            );
          if (proposal.decision === "clarify") {
            if (!proposal.message.trim())
              throw new StoreError(
                "compiler_output_invalid",
                "Clarification needs a question.",
                503,
              );
            return complete(
              tx,
              result("needs_clarification", { question: proposal.message }),
            );
          }
          if (proposal.decision === "noop") {
            if (!current.ready)
              throw new StoreError(
                "compiler_output_invalid",
                "The current memos still need a compiled report.",
                503,
              );
            return complete(
              tx,
              result("unchanged", { version: current.version }),
            );
          }
          const limits = await readLimits(tx);
          if (
            proposal.memos.length > limits.memos ||
            utf8Bytes(proposal.tps) > limits.body_bytes ||
            (proposal.memos.length === 0) !== (proposal.tps.trim() === "")
          )
            throw new StoreError(
              "compiler_output_invalid",
              "The complete proposal exceeds a limit or has no matching report.",
              422,
            );
          const known = new Map(current.active.map((h) => [h.id, h]));
          const retained = new Set<string>();
          for (const memo of proposal.memos) {
            if (
              utf8Bytes(memo.text) > limits.body_bytes ||
              utf8Bytes(memo.description) > limits.description_bytes
            )
              throw new StoreError(
                "memo_body_limit",
                "A proposed memo exceeds its size limit.",
                422,
              );
            if (memo.id !== null) {
              if (!known.has(memo.id) || retained.has(memo.id))
                throw new StoreError(
                  "compiler_output_invalid",
                  "The proposal references an unavailable or repeated memo.",
                  503,
                );
              retained.add(memo.id);
            }
          }
          const unchanged =
            proposal.memos.length === current.active.length &&
            proposal.memos.every(
              (m) =>
                m.id &&
                known.get(m.id)?.body === m.text &&
                known.get(m.id)?.description === m.description,
            );
          if (unchanged && current.ready)
            return complete(
              tx,
              result("unchanged", { version: current.version }),
            );
          const day = (
            await tx.query<{ day: string }>(
              sql`SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date::text AS day`,
            )
          )[0]!.day;
          const charged =
            await tx.query(sql`INSERT INTO usage_daily(user_id,day_utc,writes) VALUES (${userId},${day}::date,1)
            ON CONFLICT(user_id,day_utc) DO UPDATE SET writes=usage_daily.writes+1 WHERE usage_daily.writes < ${limits.daily_writes} RETURNING writes`);
          if (!charged.length)
            throw new StoreError(
              "rate_limited",
              "The daily save limit has been reached.",
              429,
            );
          const attribution = JSON.stringify({
            kind: "assistant",
            issuer: actor.issuer,
            client_id: actor.clientId,
          });
          const append = async (
            h: Pick<Head, "id" | "version" | "description" | "body">,
            archived: boolean,
            kind: string,
          ) => {
            await tx.query(sql`INSERT INTO memo_versions(user_id,memo_id,version,description,body,archived,reason,actor_json,details_json)
              VALUES (${userId},${h.id},${h.version + 1},${h.description},${h.body},${archived},'Filed memo',${attribution},${JSON.stringify({ kind, request_id: input.request_id })})`);
          };
          for (const memo of proposal.memos) {
            const old = memo.id ? known.get(memo.id) : undefined;
            if (old) {
              if (
                old.body !== memo.text ||
                old.description !== memo.description
              )
                await append(
                  { ...old, body: memo.text, description: memo.description },
                  false,
                  "update",
                );
            } else {
              const id = randomUUID();
              await tx.query(
                sql`INSERT INTO memos(user_id,id,name) VALUES (${userId},${id},${`memo-${id}`})`,
              );
              await append(
                {
                  id,
                  version: 0,
                  description: memo.description,
                  body: memo.text,
                },
                false,
                "create",
              );
            }
          }
          for (const old of current.active)
            if (!retained.has(old.id)) await append(old, true, "archive");
          const updated = await snapshot(tx);
          const next = (current.report?.revision ?? 0) + 1;
          await tx.query(sql`INSERT INTO tps_reports(user_id,revision,body,source_hash) VALUES (${userId},${next},${proposal.tps},${updated.fingerprint})
            ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,body=excluded.body,source_hash=excluded.source_hash,created_at=clock_timestamp()`);
          return complete(tx, result("saved", { version: version(next) }));
        });
      } catch (error) {
        const failure = databaseFailure(error);
        // A committed result wins even when the connection failed while returning it.
        return db
          .transaction(async (tx) => {
            await lock(tx);
            const existing = await receipt(tx, input.request_id);
            if (existing?.completed)
              return outcomeSchema.parse(existing.result_json);
            if (!existing) throw failure;
            return complete(tx, result("failed", { error: failure.code }));
          })
          .catch(() => {
            throw new StoreError(
              "save_outcome_unknown",
              "Repeat the exact same request ID and input to recover the outcome. Do not submit a new request yet.",
              503,
              { request_id: input.request_id },
            );
          });
      }
    },
  };
}
