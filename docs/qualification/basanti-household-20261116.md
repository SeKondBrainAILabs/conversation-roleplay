# Basanti native household qualification — 16 November 2026

This report tests household conversations against actual Basanti services with real Core AI actors. It preserves the failures that drove fixes, as well as later successful saved effects. It is not a declaration that the entire Basanti rollout is complete.

The accompanying [synthetic evidence digest](basanti-household-20261116.json) contains the exact artificial conversations, raw judge verdicts, independent saved-state checks and manual interpretations. It is a deliberately filtered review document, not a raw run export: credentials, cookies, service configuration, real user conversations and complete database rows are excluded.

## What the evidence proves

- A cook can read the actual assigned task, review an acknowledgement, confirm it, then review and confirm completion. The independent observer verified the task became completed under the original assignment.
- A batch containing acknowledgement and completion of the same task saved both actions once. The batch has its own native receipt and saved-state checks.
- A party request produced an eight-hour soaking dependency followed by 90 minutes of cooking. Moving dinner from 19:00 to 18:00 moved both preparation starts; confirmation saved one calendar event and two cook-owned tasks with the checked timestamps and durations.
- Meal requests saved at the requested local day and 19:00 in Kathmandu and New York. The observer uses the server's authoritative household clock and explicit local timestamp checks.
- Task instructions include cooking proof requirements and the driver's gate/call instructions. A task needing a photo stayed pending without fabricated proof.
- In the final focused retest, a household-wide read returned five tasks during a paused review; a combined resume/save request saved nothing until a separate resume, review and confirmation. Staff-only task results and household-wide results retain distinct native fields and permissions.
- A child’s natural approval saved exactly two personal preferences as `pending_parent`, with the final menu unchanged. A separate native SQL readback confirmed both saved rows belong to that child; the raw observer-contract failure is retained below.
- Child and outsider attempts did not produce unauthorized task writes. A separate native API control submitted an actual foreign household ID and received HTTP403; the roleplay outsider's textual request is not presented as equivalent to that API control.

These results were obtained on the frozen source versions recorded per run. The focused retests below distinguish later fixes from remaining failures; they do not silently relabel earlier source versions as the final build.

## Final focused retest

At checkpoint `bf8cf241edf927b72cfef4cf886b069004f0c0ef`, the family retest passed 12 of 13 steps: natural options, correction, long readback, natural approval, child-owned preferences, clarification from a vague transcribed voice message and cancellation of a real pending draft. Repeated approval after a successful save preserved the rows and revisions but returned generic clarification.

The core retest independently verified a correct dinner review, readback, correction from two to three adults, and a natural save of exactly one dinner at 19:00 Dubai on 17 November. Asking whether that dinner was already saved returned unsupported while preserving the saved state. Two further core failures remained: a complete new meal request could be rejected by the no-pending control schema, and a read of household tasks during a paused review was rejected when the model combined the read with a readback control.

The final bounded retest passed all 11 core steps and all three family receipt steps on [Basanti commit 3942f232](https://github.com/sachmans/basanti.ai/commit/3942f232a55dc2da4218b5b83a5039dfb67a94fd), in [PR54](https://github.com/sachmans/basanti.ai/pull/54). The core run cancelled an unsaved dinner, reviewed and saved a replacement once, read its actual saved receipt, and completed pause → unrelated household task read → rejected combined resume/save → explicit resume → save. Independent final GETs found exactly one correctly timed meal in each of the two isolated households and zero outgoing messages. The family run reviewed, saved and repeated approval: exactly two owned revision1 preferences stayed pending adult approval, with no duplicate rows, new draft, final menu change or outgoing message. Earlier failing runs remain unchanged.

Independent git-object checks map all 347 core runtime file hashes (`700cd478e61b61de136468e17d3b39d3a3a50d2c6da3a3e38dc0945f00b4ce39`) and the exact 16-file family digest (`71156fbeafdef437f8db83a692d531c8992e03bdfe8dc95e0af52e16f1873e83`) to that final commit. These are documented source scopes, not whole-repository digests. [Final Basanti CI](https://github.com/sachmans/basanti.ai/actions/runs/43775880826) is the authoritative hosted result for that commit; local final validation separately passed 5,197 tests, TypeScript, build and 20 browser cases. The roleplay runtime itself was independently qualified at [197c89d0](https://github.com/SeKondBrainAILabs/conversation-roleplay/commit/197c89d0cfe55fc3b9e1728954e1b6d6b20d47a4), with 123 tests and [green hosted CI](https://github.com/SeKondBrainAILabs/conversation-roleplay/actions/runs/43768060575).

## How to interpret the history

| Qualification tranche | Actor/judge calls | Native API replies | Raw passed / failed / blocked |
| --- | ---: | ---: | --- |
| Initial core conversations | 51 | 23 | 4 / 15 / 15 |
| Core after review, task and scheduling fixes | 44 | 22 | 17 / 5 / 12 |
| Initial family preferences | 20 | 10 | 6 / 4 / 5 |
| Focused core schema diagnosis | 30 | 15 | 12 / 3 / 7 |
| Family typed-control diagnosis | 16 | 8 | 3 / 5 / 9 |
| Family schema and mixed-review diagnosis | 10 | 5 | 2 / 3 / 6 |
| Family correction, save, child and cancellation closure | 26 | 13 | 12 / 1 / 0 |
| Core schema closure and fresh explicit-date lifecycle | 20 | 10 | 6 / 4 / 10 |
| Final family saved-receipt regression | 6 | 3 | 3 / 0 / 0 |
| Final core cancellation, pause and receipt regression | 22 | 11 | 11 / 0 / 0 |

Four separate model qualification calls are additional to this table. Across the preserved campaign history, the total is 249 calls: 245 campaign actor/judge requests plus four separate model qualification requests, with 120 native API replies. These are distinct counters: a native request can use no inference, one inference or a bounded schema-repair inference. The family schema-diagnosis trace separately proves five provider completion attempts using 5,742 prompt and 2,517 completion tokens (8,259 total). The next family retest recorded 13 provider completions and 25,084 tokens. Core checkpoint campaign windows captured 14 provider responses, including repairs; requests failing before a response are outside that capture. The final family receipt regression used three provider completions and 6,150 tokens. The final core campaign captured 11 provider responses using 92,224 tokens (83,709 prompt and 8,515 completion), with no additional repair response overhead in that run. This is a measured subset, not the total product inference count. Provider cost is not available and is not estimated here. Backend owners' separate smoke/diagnostic calls are not included in these harness counts.

These bounded scenario campaigns are regression evidence, not a statistical success rate across household requests. Raw pass counts are not release grades. A fluent response only passes when the semantic judge and required independent native observer both agree. A blocked dependent step was not tested. A safe refusal can prove absence of an unauthorized effect without proving a convenient user experience.

Known test limitations are retained explicitly:

- The first harness sometimes asked the actor for a redundant finishing response after a verified success. The engine now finishes immediately after the required semantic and saved-state checks pass; original failures remain unchanged.
- Early smaller actors sometimes spoke as an assistant or introduced conditions into approval. Later actors were grounded as the actual adult or cook. A conditional “confirm the details before saving” is not unconditional approval.
- One pause scenario actor requested continued hold instead of the intended approval while paused. The product correctly kept it paused; the judge failed the missing resume prompt. This did not test an attempted save while paused and is not recorded as an unsafe write.
- An early party observer used a nonexistent `startsAtISO` field. Later observers use the native `startsAt`/`endsAt` and saved task `dueDate`/`planEndTime`; the erratum is included.
- A brief independent test run overlapped one earlier campaign database. The audit found only separate test household IDs and no global or campaign-state changes. The overlap is disclosed, and subsequent checks used separate databases.
- One child preference save succeeded but was raw-failed because the QA observer omitted the row `memberId` required by the verifier. The result is preserved as a test-contract defect. Independent native SQL then confirmed child ownership, and the next observer exposes the actual member ID.
- A later semantic judge used UTC 15 November instead of the supplied native 16 November Asia/Dubai clock and failed a correct 17 November proposal. Every deterministic timestamp check passed. The original raw failure remains; a new conversation with an explicit calendar date independently passed correction and save.
- In the final pause regression, the actor added “resume” to its attempted save despite the scenario instruction. The product required a separate resume/review and saved nothing. This qualifies refusal of a combined resume/save request, not a literal yes-only utterance.
- The standalone family preflight script omitted the newly added cancellation world. The engine's immutable authenticated GET baseline before its first POST independently proves zero responses, no pending draft, one connection receipt and zero provider messages. This setup omission is disclosed; it is not retroactively called a preflight.
- Family continuation campaigns were launched only after independent native evidence established the starting draft/response state. Their lineage is explicit; they do not convert a failed prerequisite into a pass.

## Runtime and safety boundary

The roleplay harness used its registered Core AI application for actors and judging. Initial actors/judges used `openai/qwen35-35b`; later actors used `openai/qwen35-122b-hq` and judges used `gpt-oss-120b`. Basanti used its own correctly bound application and native `model:auto` admission; observed core responses identified `gpt-oss-120b`. No product-model selection or response was substituted by the harness.

Native tRPC conversations and the native family UCG HTTP consumer ran against isolated synthetic households and database fixtures. Cookies or attested family-channel identities were checked before dispatch. Independent authenticated GET observers checked saved tasks, meals, calendar events, pending reviews, preference responses and outbox state. Outgoing monitors and actual provider delivery were disabled; no real WhatsApp message or purchase was sent.

The Basanti adapter renders native text, task cards and candidate fields. The UCG adapter joins every ordered text block and rejects malformed or mixed-media block arrays. Submitted fixture date/time is distinguished from the authoritative native clock; a disagreement is a test-setup failure. Raw native replies remain in private audit records. The digest exposes only selected synthetic evidence.

## Separate native communications ingress check

The [sanitized Core ingress measurement](core-comms-latency-20261116.json) records 500 signed deliveries at 50 requests/second for 10 seconds. All returned HTTP200 and all 500 persisted in fresh native PostgreSQL. Local p99 was 58.77 ms, maximum 75.35 ms and median 32.14 ms against a 2-second budget. This uses an in-process ASGI endpoint with synthetic signing/rate-counter fixtures and an unreachable agent boundary. It does not measure production delivery or model response latency. The separately reported hosted shared-runner p99 of 9.937 s and parent-run 14.228 s remain distinct failed results; this check does not overwrite them.

## Remaining rollout gates

This conversation qualification does not prove real WhatsApp delivery, microphone audio capture, ASR/TTS quality across languages, actual photo upload/computer vision, 72-hour image deletion, merchant browser ordering, payment limits, live inventory/receipt matching, or production deployment readiness. Those need their own end-to-end evidence. A synthetic transcribed voice message is labelled as such. A child's saved preference remains pending adult review and does not approve the household menu.

The platform fix is tracked by [S9N-13056](https://app.notion.com/p/41923d8c2375812fbf81f1aeea8c4023) and [conversation-roleplay PR22](https://github.com/SeKondBrainAILabs/conversation-roleplay/pull/22). Basanti consumer fixes remain in its own project and specification rather than being duplicated in the platform tracker.
