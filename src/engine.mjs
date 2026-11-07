/** Dependency scheduler and adaptive conversations. Only verified outputs cross role boundaries. */
import { EventEmitter } from 'node:events';
import { preflightCampaignRepairs } from './clarifications.mjs';
import { validateCampaign } from './contracts.mjs';
import { instructionResults } from './instructions.mjs';
import { assert, at, clone, now, redact, sleep, uuid } from './util.mjs';

const good = new Set(['passed', 'simulated']);
const terminal = new Set([
  'passed',
  'simulated',
  'failed',
  'blocked',
  'unverified',
  'outcome_unknown',
  'stopped',
]);

export class CampaignRun extends EventEmitter {
  constructor(
    campaign,
    {
      adapter,
      actorModel,
      judgeModel = actorModel,
      repairAdapter,
      store,
      secrets = [],
    },
  ) {
    super();
    this.campaign = validateCampaign(campaign);
    this.adapter = adapter;
    this.actorModel = actorModel;
    this.judgeModel = judgeModel;
    this.repairAdapter = repairAdapter;
    const repairCheck = preflightCampaignRepairs(
      this.campaign,
      adapter.config?.repairContracts,
      repairAdapter,
    );
    assert(
      !repairCheck.enabled || repairCheck.ready,
      'HAI answers required before starting; run repair preflight',
    );
    this.store = store;
    this.secrets = secrets;
    this.controller = new AbortController();
    this.activeActors = new Set();
    this.calls = 0;
    this.eventSequence = 0;
    this.state = {
      id: uuid(),
      name: this.campaign.name,
      target: this.campaign.target,
      status: 'preparing',
      startedAt: now(),
      modelCalls: 0,
      demo:
        adapter.kind === 'demo' ||
        actorModel.kind === 'demo' ||
        judgeModel.kind === 'demo',
      campaign: clone(this.campaign),
      roles: clone(this.campaign.roles),
      steps: [],
      events: [],
      qualified: false,
    };
    for (const scenario of this.campaign.scenarios)
      for (const step of scenario.steps)
        this.state.steps.push({
          scenarioId: scenario.id,
          scenarioTitle: scenario.title,
          worldId: scenario.worldId,
          ...clone(step),
          status: 'pending',
          transcript: [],
          artifacts: {},
          conversationId: null,
          inFlight: false,
        });
    this.persist();
  }
  snapshot() {
    return redact(this.state, this.secrets);
  }
  persist() {
    this.store?.save(this.state);
  }
  record(type, details = {}) {
    const event = redact(
      { sequence: ++this.eventSequence, at: now(), type, ...details },
      this.secrets,
    );
    this.state.events.push(event);
    this.store?.event(this.state.id, event);
    this.persist();
    this.emit('update', this.snapshot());
  }
  pause() {
    if (this.state.status === 'running') {
      this.state.status = 'paused';
      this.record('run.paused');
    }
  }
  resume() {
    if (this.state.status === 'paused') {
      this.state.status = 'running';
      this.record('run.resumed');
    }
  }
  stop() {
    if (['running', 'paused', 'preparing'].includes(this.state.status)) {
      this.state.status = 'stopping';
      this.record('run.stopping');
      this.controller.abort(new Error('Run stopped'));
    }
  }
  async waitWhilePaused() {
    while (this.state.status === 'paused')
      await sleep(80, this.controller.signal);
  }
  async model(model, purpose, payload) {
    assert(!this.controller.signal.aborted, 'Run stopped');
    assert(
      ++this.calls <= this.campaign.maxModelCalls,
      'Campaign model-call budget exhausted',
    );
    this.state.modelCalls = this.calls;
    this.persist();
    return model.complete(purpose, redact(payload, this.secrets), {
      signal: this.controller.signal,
    });
  }
  dependencies(step) {
    return step.dependsOn.map((id) =>
      this.state.steps.find(
        (other) => other.scenarioId === step.scenarioId && other.id === id,
      ),
    );
  }
  orderedPredecessors(step) {
    return (step.after ?? []).map((id) =>
      this.state.steps.find(
        (other) => other.scenarioId === step.scenarioId && other.id === id,
      ),
    );
  }
  followupAncestors(step, result = new Set()) {
    for (const previous of this.orderedPredecessors(step)) {
      if (!result.has(previous.id)) {
        result.add(previous.id);
        this.followupAncestors(previous, result);
      }
    }
    return result;
  }
  sharedFacts(step) {
    return Object.fromEntries(
      this.dependencies(step).map((dependency) => [
        dependency.id,
        clone(dependency.artifacts),
      ]),
    );
  }
  actorKey(step) {
    return `${step.worldId}/${step.actorId}`;
  }
  async enhanceRoles() {
    if (
      this.campaign.roles.every(
        (role) => role.persona && typeof role.persona === 'object',
      )
    ) {
      this.record('roles.enhanced', { source: 'provided_personas' });
      return;
    }
    const result = await this.model(this.actorModel, 'enhance', {
      roles: this.campaign.roles,
    });
    assert(
      Array.isArray(result.roles) &&
        result.roles.length === this.campaign.roles.length,
      'Role enhancement changed the role count',
    );
    this.state.roles = this.campaign.roles.map((role) => {
      const matches = result.roles.filter((value) => value.id === role.id);
      assert(
        matches.length === 1 &&
          matches[0].name === role.name &&
          matches[0].persona &&
          typeof matches[0].persona === 'object',
        'Role enhancement changed a role identity or omitted its persona',
      );
      return { ...role, persona: role.persona ?? matches[0].persona };
    });
    this.record('roles.enhanced');
  }
  async start() {
    assert(
      !this.started,
      'A run can only start once; inspect or create a fresh isolated campaign instead',
    );
    this.started = true;
    const deadline = setTimeout(() => {
      this.state.deadlineExceeded = true;
      this.stop();
    }, this.campaign.maxDurationMs);
    deadline.unref();
    this.record('run.preparing');
    try {
      await this.enhanceRoles();
      if (this.controller.signal.aborted) throw new Error('Run stopped');
      this.state.status = 'running';
      this.record('run.started');
      const active = new Map();
      while (
        this.state.steps.some((step) => !terminal.has(step.status)) ||
        active.size
      ) {
        if (this.controller.signal.aborted) {
          for (const step of this.state.steps.filter(
            (step) => step.status === 'pending',
          ))
            step.status = 'stopped';
        }
        for (const step of this.state.steps.filter(
          (step) => step.status === 'pending',
        )) {
          const dependencies = this.dependencies(step);
          const ordered = this.orderedPredecessors(step);
          if (
            dependencies.some(
              (dep) => terminal.has(dep.status) && !good.has(dep.status),
            ) ||
            ordered.some(
              (dep) =>
                terminal.has(dep.status) &&
                (['outcome_unknown', 'stopped', 'blocked'].includes(
                  dep.status,
                ) ||
                  !dep.transcript.some((turn) => turn.role === 'assistant')),
            )
          ) {
            step.status = 'blocked';
            step.error = 'A prerequisite did not pass independent evaluation';
            this.record('step.blocked', this.ref(step));
          }
        }
        if (this.state.status === 'running') {
          for (const step of this.state.steps) {
            if (active.size >= this.campaign.concurrency) break;
            if (
              step.status !== 'pending' ||
              this.activeActors.has(this.actorKey(step)) ||
              !this.dependencies(step).every((dep) => good.has(dep.status)) ||
              !this.orderedPredecessors(step).every((dep) =>
                terminal.has(dep.status),
              )
            )
              continue;
            step.status = 'running';
            this.activeActors.add(this.actorKey(step));
            const promise = this.execute(step).finally(() => {
              this.activeActors.delete(this.actorKey(step));
              active.delete(step);
            });
            active.set(step, promise);
          }
        }
        if (active.size) await Promise.race([...active.values(), sleep(80)]);
        else if (this.state.status === 'paused') await sleep(80);
        else if (this.state.steps.some((step) => step.status === 'pending'))
          throw new Error('Scheduler cannot make progress');
      }
      this.state.status = this.controller.signal.aborted
        ? 'stopped'
        : this.state.steps.every((step) => good.has(step.status))
          ? 'completed'
          : 'failed';
    } catch (error) {
      this.state.status = this.controller.signal.aborted ? 'stopped' : 'failed';
      this.state.error = String(error.message);
      for (const step of this.state.steps.filter(
        (step) => step.status === 'pending',
      ))
        step.status = 'blocked';
    }
    clearTimeout(deadline);
    this.state.finishedAt = now();
    this.state.summary = Object.fromEntries(
      [...terminal].map((status) => [
        status,
        this.state.steps.filter((step) => step.status === status).length,
      ]),
    );
    this.state.qualified =
      !this.state.demo &&
      this.state.status === 'completed' &&
      this.state.steps.every(
        (step) =>
          step.verification?.status === 'passed' &&
          step.judgment?.verdict === 'pass',
      );
    this.record('run.finished', { status: this.state.status });
    return this.snapshot();
  }
  ref(step) {
    return {
      scenarioId: step.scenarioId,
      stepId: step.id,
      actorId: step.actorId,
    };
  }
  activity(step, phase) {
    step.activity = { phase, since: now() };
    this.record('step.activity', { ...this.ref(step), phase });
  }
  async execute(step) {
    const ref = this.ref(step);
    step.startedAt = now();
    const actor = this.state.roles.find((role) => role.id === step.actorId);
    // Actors share a conversation within one scenario, never with other scenarios or roles.
    const followups = this.followupAncestors(step);
    const prior = this.state.steps.filter(
      (other) =>
        other !== step &&
        other.scenarioId === step.scenarioId &&
        other.actorId === step.actorId &&
        (good.has(other.status) ||
          (followups.has(other.id) &&
            other.transcript.some((turn) => turn.role === 'assistant'))),
    );
    step.conversationId = prior.at(-1)?.conversationId ?? uuid();
    const history = prior.flatMap((other) =>
      other.transcript.map((turn) => ({ role: turn.role, content: turn.text })),
    );
    const input = {
      actor,
      step,
      worldId: step.worldId,
      shared: this.sharedFacts(step),
      conversationId: step.conversationId,
      runId: this.state.id,
      history,
    };
    this.record('step.started', ref);
    try {
      if (step.effect === 'write' && !step.verifierId && !this.state.demo)
        throw new Error(
          'Write steps require a configured independent verifier before sending any request',
        );
      if (step.exports && !step.verifierId && !this.state.demo)
        throw new Error('Shared artifacts require an independent verifier');
      if (this.adapter.prepareStep) {
        this.activity(step, 'checking_identity');
        input.beforeEvidence = await this.adapter.prepareStep(input, {
          signal: this.controller.signal,
        });
        step.beforeEvidence = clone(input.beforeEvidence);
        this.record('step.observer_ready', ref);
      }
      if (step.kind === 'fixture') {
        await this.waitWhilePaused();
        step.inFlight = true;
        this.activity(step, 'applying_fixture');
        this.record('fixture.sending', ref);
        step.response = await this.adapter.fixture(input, {
          signal: this.controller.signal,
        });
        step.inFlight = false;
        this.record('fixture.received', ref);
        this.activity(step, 'verifying');
        step.verification = await this.adapter.verify(input, {
          signal: this.controller.signal,
        });
        step.judgment = {
          verdict: step.verification.status === 'passed' ? 'pass' : 'uncertain',
          goalComplete: step.verification.status === 'passed',
          category: 'none',
          reason:
            'Explicit fixture plus independent verification; no conversational quality claim',
          evidence: [],
        };
      } else {
        let lastJudgment;
        for (let turn = 0; turn <= step.maxTurns; turn++) {
          await this.waitWhilePaused();
          this.activity(step, 'composing');
          const action = await this.model(this.actorModel, 'actor', {
            actor,
            step,
            sharedFacts: input.shared,
            conversationHistory: history,
            transcript: step.transcript,
            latestVerification: step.verification,
            instructionResults: step.instructionResults,
          });
          assert(
            typeof action.message === 'string' &&
              action.message.length <= 4000 &&
              typeof action.done === 'boolean',
            'Actor returned an invalid turn',
          );
          if (!step.transcript.length && step.instructions?.length) {
            assert(
              Array.isArray(action.instructionIds) &&
                action.instructionIds.length === step.instructions.length &&
                new Set(action.instructionIds).size ===
                  action.instructionIds.length &&
                step.instructions.every((instruction) =>
                  action.instructionIds.includes(instruction.id),
                ),
              'Actor did not include every requested instruction in its opening turn',
            );
          }
          if (action.done && step.transcript.length) break;
          if (turn === step.maxTurns) break;
          assert(
            action.message.trim(),
            'Actor must send a message or finish an existing conversation',
          );
          const messageId = uuid();
          step.transcript.push({
            role: 'user',
            text: action.message,
            at: now(),
            messageId,
          });
          step.inFlight = true;
          step.pendingMessageId = messageId;
          this.activity(step, 'waiting_reply');
          this.record('turn.sending', { ...ref, messageId });
          const response = await this.adapter.send(
            {
              ...input,
              message: action.message,
              messageId,
              history: [
                ...history,
                ...step.transcript
                  .slice(0, -1)
                  .map((item) => ({ role: item.role, content: item.text })),
              ],
            },
            { signal: this.controller.signal },
          );
          step.response = response;
          step.inFlight = false;
          step.transcript.push({
            role: 'assistant',
            text: response.text,
            at: now(),
            status: response.status,
            messageId,
          });
          this.record('turn.received', { ...ref, messageId });
          this.activity(step, 'verifying');
          try {
            step.verification = await this.adapter.verify(input, {
              signal: this.controller.signal,
            });
          } catch {
            step.verification = {
              status: 'unavailable',
              checks: [],
              reason:
                'Independent observer unavailable; success cannot be established',
            };
          }
          this.activity(step, 'evaluating');
          lastJudgment = await this.model(this.judgeModel, 'judge', {
            actor,
            goal: step.goal,
            effect: step.effect,
            conversationHistory: history,
            transcript: step.transcript,
            response,
            verification: step.verification,
            sharedFacts: input.shared,
            phase: 'in_progress',
            instructions: step.instructions,
          });
          assert(
            ['pass', 'fail', 'uncertain'].includes(lastJudgment.verdict) &&
              typeof lastJudgment.goalComplete === 'boolean' &&
              typeof lastJudgment.reason === 'string',
            'Invalid judge verdict',
          );
          step.instructionResults = instructionResults(
            step,
            lastJudgment,
            step.verification,
          );
          step.judgment = lastJudgment;
          step.transcript.at(-1).judgment = clone(lastJudgment);
          step.transcript.at(-1).verification = {
            status: step.verification.status,
            checks: step.verification.checks,
          };
          step.transcript.at(-1).instructionResults = clone(
            step.instructionResults,
          );
          this.record('turn.evaluated', {
            ...ref,
            verdict: lastJudgment.verdict,
          });
          // A discovered failure stays visible; further blind writes do not make it a pass.
          if (
            lastJudgment.verdict === 'fail' ||
            step.instructionResults.some((item) =>
              ['failed', 'invalid_request'].includes(item.status),
            )
          )
            break;
        }
        if (!step.judgment)
          throw new Error('No completed target turn was evaluated');
      }
      const observerNeeded =
        step.effect === 'write' ||
        Boolean(step.verifierId) ||
        Boolean(step.exports);
      if (
        step.judgment.verdict === 'fail' ||
        step.verification?.status === 'failed' ||
        step.instructionResults?.some((item) =>
          ['failed', 'invalid_request'].includes(item.status),
        )
      )
        step.status = 'failed';
      else if (
        step.judgment.verdict !== 'pass' ||
        !step.judgment.goalComplete ||
        step.instructionResults?.some((item) => item.status !== 'passed') ||
        (observerNeeded && step.verification?.status !== 'passed')
      )
        step.status = 'unverified';
      else step.status = this.state.demo ? 'simulated' : 'passed';
      if (good.has(step.status)) {
        for (const [name, path] of Object.entries(step.exports ?? {})) {
          const value = at(step.verification.evidence, path);
          assert(value !== undefined, `Verified artifact ${name} was absent`);
          step.artifacts[name] = clone(value);
        }
      }
      if (
        step.status === 'failed' &&
        step.repairContractId &&
        this.repairAdapter
      ) {
        const contract =
          this.adapter.config?.repairContracts?.[step.repairContractId];
        this.activity(step, 'repairing');
        step.repair = await this.repairAdapter.repair({
          category: step.judgment.category,
          contract,
          clarificationAnswers:
            this.campaign.repairAnswers?.[step.repairContractId],
          runId: this.state.id,
          scenarioId: step.scenarioId,
          stepId: step.id,
          signal: this.controller.signal,
          checkpoint: async (receipt) => {
            step.repair = clone(receipt);
            this.record('repair.checkpoint', ref);
          },
          emit: (receipt) =>
            this.record('repair.updated', { ...ref, status: receipt.status }),
        });
      }
    } catch (error) {
      step.status =
        step.inFlight || error.outcomeUnknown
          ? 'outcome_unknown'
          : this.controller.signal.aborted
            ? 'stopped'
            : 'failed';
      step.error = error.message;
      if (!step.inFlight) delete step.pendingMessageId;
    }
    step.finishedAt = now();
    step.activity = { phase: 'finished', since: step.finishedAt };
    this.record('step.finished', { ...ref, status: step.status });
  }
}
