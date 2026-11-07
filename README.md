# Conversation Roleplay

[![Module checks](https://github.com/SeKondBrainAILabs/conversation-roleplay/actions/workflows/test.yml/badge.svg)](https://github.com/SeKondBrainAILabs/conversation-roleplay/actions/workflows/test.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A reusable, MIT-licensed conversation testing module for PiggyBank, Basanti and other conversational systems. Give it roles and a brief; an LLM expands the personas, proposes scenarios, and plays each actor through adaptive turns. Independent stories run concurrently. Steps in a shared story wait for their prerequisites and receive only verified exported facts.

The local dashboard shows an actor conversation board, scenario dependencies, per-turn evaluation, independent API evidence and HAI proposal status. You can pause, stop, inspect archived runs and export sanitized JSON.

![Conversation board showing four fictional actors and a simulated lesson lifecycle](docs/images/conversation-board.png)

## Run locally

Requires Node.js 22 or later. No package installation, product dependency or external service is needed for the demo.

```sh
git clone https://github.com/SeKondBrainAILabs/conversation-roleplay.git
cd conversation-roleplay
npm start
# Open http://127.0.0.1:4318 and click Run interactive demo
```

The included example follows **parent creates lesson → teacher schedules → an explicit QA fixture simulates the lesson happening → teacher records feedback → child reads a summary**. An assistant conversation runs alongside. A separate seeded failure shows a HAI proposal and a blocked dependent step.

**Demo mode is deterministic simulation. It does not call an LLM, PiggyBank, Basanti or HAI, and never qualifies a product.** Its intentionally failed branch makes `npm run demo` exit with code 1. A proposal is never shown as a verified repair.

```sh
npm test
npm run check
node src/cli.mjs validate examples/lesson-lifecycle.json
node src/cli.mjs run examples/lesson-lifecycle.json --demo
node src/cli.mjs serve --port 4318 --runs /path/to/private/run-artifacts
```

## Connect a real model and target

Copy `config.example.json` to an untracked `config.local.json`. Configure your provider's full chat-completions URL and an available model. The JSON client accepts the standard `messages` / `choices[0].message.content` envelope; use the generic adapter or a custom model implementation for other protocols. `actorModel` and `judgeModel` can override `llm` independently. No default external model, credentials or production endpoint is assumed.

```sh
ROLEPLAY_CONFIG=/absolute/path/config.local.json npm start
```

All `headersEnv` values are **environment variable names**, never literal credentials. Environment values remain server-side and are redacted from prompts, transcripts and reports. Observer and fixture credentials can be separate from actor credentials. Do not place credentials in actor context, role descriptions or campaign JSON. Local artifacts can contain fictional QA names and conversation text; they are not intended as a collector of private real-family conversations.

Each live scenario world needs explicit synthetic QA actor bindings. For example, under `targets.piggybank.bindings`:

```json
{
  "lessonQA": {
    "parent": {
      "qa": true,
      "context": {
        "userId": "PROVISIONED_QA_PARENT_ID",
        "familyId": "PROVISIONED_QA_FAMILY_ID",
        "role": "parent",
        "mode": "kora_parent_assistant"
      },
      "headersEnv": { "Authorization": "QA_PARENT_TOKEN" },
      "observerHeadersEnv": { "Authorization": "QA_OBSERVER_TOKEN" }
    }
  }
}
```

Add separate teacher and child identities in the same world for a shared-family lifecycle. Independent stories need different worlds and independently provisioned QA families/households; the built-in adapter rejects two worlds mapped to the same family. For other products, use an explicit `isolationKey` in each binding. A world may be shared intentionally; requests for the same actor in that world are serialized. The dashboard also reserves scope fingerprints across active runs and runs with uncertain requests or HAI submissions, preventing an accidental overlapping campaign. There is no automatic fixture provisioning, broad cleanup or real WhatsApp sending.

Live targets must declare a GET-only `identity` hook with assertions against the bound user and family/household. Actor role/family authority remains enforced by the product API. A failed identity check prevents chat submission. Configured endpoints cannot be changed by generated personas, scenarios or target replies.

### Target adapters

- **PiggyBank:** authenticated `POST /api/ai/chat`, stable conversation/message IDs, actor mode, family/child context, web text channel and conversation history. This does not exercise WhatsApp inbound workers, voice or attachment transport.
- **Basanti:** authenticated tRPC `staffConversation.ask`, with its strict UUID message/conversation IDs, household ID, date and timezone. Supply `householdId`, `date` (`YYYY-MM-DD`) and `timezone` in the binding context, a QA session cookie through `headersEnv.Cookie`, and reviewed identity/observer hooks. Response extraction reads `result.data.json.reply.text`. This adapter covers the staff conversation surface; homeowner onboarding and confirmation decisions are separate surfaces and are not silently substituted.
- **Generic HTTP:** server-configured `chat.path`, `chat.body` and `responsePaths`. Use `$message`, `$messageId`, `$conversationId`, `$history`, `$actor.someField`, `$step.someField` or `$shared.createLesson.lessonId` references. References preserve JSON types. Paths support encoded `{actor.familyId}`-style parameters. No expressions, shell commands or model-chosen URLs are evaluated.
- **Custom library adapters:** implement `send(input, {signal})`, `verify(input, {signal})`, optionally `fixture`, `manifest` and `config.repairContracts`. A custom implementation can exercise a browser, streaming channel or a product-specific test API without changing the scheduler.

The PiggyBank and Basanti envelopes were checked against local source contracts. Real product credentials, verified deployment revisions and fixture hooks are intentionally not bundled. A new live run is required before claiming either product works with the complete workflow.

## Define scenarios and actual outcomes

Campaigns are versioned JSON. The dashboard's generator produces a **reviewable draft**, never a claim that it ran. It can only reference operator-configured verifier, fixture and repair IDs. Review goals, prerequisites and hooks before starting. The role enhancer can add a persona but cannot change the supplied role identity or description; product permissions never come from the persona.

Each scenario has a `worldId` and a dependency DAG. Every step has an `actorId`, a goal, a turn budget and an effect (`read`, `write`, `none`). A write cannot be sent without an independent verifier. `exports` select facts from verified observer evidence, not from assistant text, for downstream steps. A failed or unverified step blocks its dependents. Actor conversation history is retained within the same scenario and actor; other actors' private turns are not injected.

Use an explicit `fixture` step to simulate an external event or elapsed time in QA. Its hook requires `allowFixtureWrites:true`, a configured endpoint/body and an independent verifier. No LLM can invent a fixture or pretend a lesson happened. Real-time scheduling and clock advancement belong to the target's test adapter.

Verifier hooks are GET-only, with assertions such as:

```json
{
  "lessonSaved": {
    "path": "/api/qa/lessons/{shared.createLesson.lessonId}",
    "description": "Read back the saved lesson in the isolated QA fixture",
    "assertions": [
      {
        "label": "Correct child",
        "path": "lesson.childId",
        "op": "eq",
        "expected": "$actor.expectedChildId"
      },
      {
        "label": "Feedback recorded",
        "path": "lesson.feedback",
        "op": "exists"
      }
    ]
  }
}
```

This illustrates a hook contract, **not an existing PiggyBank or Basanti endpoint**. Map real reviewed API surfaces in your local config. Supported assertions: `exists`, `eq`, `gte`, `includes`, `contains`, `length`, `unchanged`. The built-in HTTP adapter reads the observer before sending a step: final-state predicates may still be false, but an unavailable observer prevents the action. `unchanged` compares an exact field against that initial evidence. Observers used for creation must support reading the initial empty state, for example a scoped list endpoint rather than an ID that does not exist yet. Do not use a broad `exists` check when success requires exact child, status, amount or duplication checks. For several API surfaces, implement a custom verifier returning `{status,checks,evidence}`.

The actor proposes the next user message. A separately prompted judge evaluates each target response for relevance, context, wrong targets and unsupported claims. It also reports whether the goal is complete. Deterministic evidence has final authority over saved effects: a failed readback cannot be overridden by an LLM verdict. A read with no observer is labelled by its semantic result but cannot qualify a campaign. The `qualified` flag means the configured checks passed; it is not an assertion of exhaustive product coverage or an independently calibrated judge.

Runs have bounded concurrency (1–20), turns per step (1–12), model calls (default 250, maximum 5,000) and wall time (default 30 minutes, maximum 3 hours). Pause prevents new turns after the current operation settles. Stop aborts requests; an aborted or disconnected mutation may have an unknown outcome. It is quarantined, never automatically retried.

## HAI integration and adapter repair

The lab has its **own optional HAI client**, but the product retains authority over skill installation and household operations. Enable it only after the provider's contract and dedicated service identity have been reviewed. Each product needs its own negotiated integration; reusing another product's credentials or widening role names does not establish compatibility.

The adapter preserves the original test goal throughout the proposal lifecycle:

1. Carry an operator-authored generic capability goal and exact expected operation IDs. Do not collapse a specific request into an unrelated “application capability”, or send raw household conversations to the provider.
2. Send only the intended allowed operations, role and confirmation boundaries. Reject unrelated, executable or authority-widening proposals locally.
3. Persist submission intent before exactly one POST. Keep the accepted provider run ID. A timeout with an uncertain submission is not resubmitted. Polling reads stay on the same run; a transient `failed` status without `completed_at` is not considered terminal.
4. Correct permission denials and existing response bugs do not trigger capability creation. Only an eligible, configured missing-capability finding does.
5. Provider completion yields at most `proposal_ready`. A product sandbox, original failed scenario, neighbouring regressions and controlled registry promotion are still required before reporting a fixed capability. The lab never auto-promotes source code or blindly repeats a business write.

Declare `repairContracts` under a target, then attach a `repairContractId` to an eligible scenario step:

```json
{
  "feedbackGap": {
    "summary": "Read assigned lesson feedback with its lesson identity and child scope.",
    "role": "coach",
    "expectedOperationIds": ["lesson-feedback-read"],
    "operations": [
      {
        "id": "lesson-feedback-read",
        "apiPath": "/api/REPLACE_WITH_REVIEWED_FEEDBACK_ROUTE",
        "apiMethod": "get",
        "roles": ["coach"],
        "category": "read",
        "requiresConfirmation": false
      }
    ]
  }
}
```

The built-in proposal envelope defaults to the inspected `piggybank.api_capability_proposal.v1` provider contract. That is a **product-specific provider contract**, not a universal role protocol. Another product requires its own negotiated protocol/service scope or a custom repair adapter. Service credentials alone do not establish compatibility. HAI feedback/revision, product installation, graph publication and automatic post-install retesting are not implemented in this initial module. This module does not deploy changes to connected products.

## Run evidence and integration boundaries

The dashboard serves only on `127.0.0.1`, checks Host/Origin, requires a per-process request token for mutations, escapes message content, and applies a restrictive content security policy. Use an authenticated deployment wrapper before exposing it to other machines. It has no remote multi-user authentication or tenant administration interface.

The configured run directory stores private JSON snapshots and an append-only event journal. Only one server/CLI process may own a run directory at a time, so a second launch cannot rewrite the first process's active evidence. On restart, unfinished runs become `interrupted`; in-flight requests become `outcome_unknown`. They remain inspectable. There is deliberately no automatic action replay or unsafe resume. Exports include the campaign, enhanced personas, exact messages, per-turn verdicts, observer evidence and repair receipts, with credentials redacted. A run error, unavailable verifier or exhausted budget is visible rather than converted to success.

This first version is a standalone local package and does not require CognitionOS. Its stable run/scenario/step/conversation/message/provider IDs and evidence can later be ingested into a shared capability/evaluation graph. Persist only concise evidence and decision provenance there, not private model reasoning or credentials. Product API state remains authoritative.

## Repository and validation

`src/` contains the engine and adapters, `web/` the dependency-free dashboard, `examples/` a complete lifecycle, and `test/` scheduler, HTTP contract, HAI and server regressions. The project can live in its own repository and be imported by other products through `src/index.mjs`; it does not import either product's source or databases.

Validation commands test concurrency/dependency ordering, actor context, blocked outcomes, identity and credential separation, actual request envelopes, no duplicate ambiguous submissions, restart quarantine, judge uncertainty, secret redaction, CSRF and exported evidence. Browser smoke checks cover the board, timeline, inspection, campaign creation, pause/stop and narrow-screen layout. These are module tests, not a claim that a live PiggyBank or Basanti campaign passed.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local checks and adapter contributions.

## License

Released under the [MIT License](LICENSE). The source is open; no npm registry release is currently published.
