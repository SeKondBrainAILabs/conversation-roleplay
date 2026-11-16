# Judge completion is scoped to the current step

The engine evaluates after each target reply. Its judge payload uses
`evaluationStage: "after_target_reply"` to describe that point in execution. This
is not product state and does not imply that the requested goal is incomplete.

`goalComplete` concerns the current step's goal and supplied instructions. An
unsaved review can complete a review-only step, even though the product still
requires confirmation before saving. A correct refusal can complete a step that
tests that refusal, with the required absence-of-effects evidence. Later scenario
steps and actor persona motivation add no requirements. Conversely, a proposal
does not satisfy a goal that requires saving, and clarification remains incomplete
when the current goal still needs information or an outcome.

The engine still requires a passing, complete semantic judgment, every supplied
instruction to pass, and all required independent observers to pass. A raw
`pass` with `goalComplete: false` remains unverified and blocks dependent steps.
A failed deterministic check cannot be overridden by a fluent model response.
This change does not add approval, permit effects, retry a request or alter actor
behavior. It does not automatically mark review, read or refusal steps complete.

## Preserved diagnosis

[S9N-13207](https://app.notion.com/p/41a23d8c237581aaa326c7414e93d8db)
tracks a general harness defect exposed by the isolated Basanti campaign
`d6f86504-3e6b-48f7-9340-7b7306480f06` on 17 November 2026 (Asia/Dubai).
Harness `bca916486d0383982452450306a2553d38c4232d` injected
`phase: "in_progress"` on every conversational judge call. The product adapter
did not supply this field. The judge interpreted that orchestration label as a
mandatory incomplete outcome, despite explicitly recognizing that the current
unsaved correction review was correct and all seven native observer checks
passed.

The raw run remains one passed, one unverified and two blocked steps. Basanti
`0a887edd19009902dcc9318f2d43085ed792523d` showed the correct corrected 20:00 review;
save and readback were not executed. Six actor/judge completions and two product
completions produced zero business effects. This is not a passed end-to-end
journey. The original judgment is not rewritten, and a future campaign must have
its own source and result evidence.

## Verification and rollout boundaries

`test/judge-completion.test.mjs` captures the actual engine-to-model transport
request using a controlled completion response. It verifies neutral metadata,
the current-step prompt contract, preserved incomplete judgments, required
observer failures/unavailability, approval/save boundaries, refusal, and
failed/missing instruction judgments. These controlled tests establish the
request and gate contracts; they do not establish actual-model reliability.

No provider, model, temperature, token budget, routing, retry, authority or
verification setting changes. Rollback is a revert of the narrow source change;
no database migration or environment change is needed. Actual-model acceptance
requires a separately authorized isolated campaign after independent source
review. Historical runs remain immutable.
