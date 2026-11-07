/** Live conversation board; target/model text is always escaped before rendering. */
const $ = (id) => document.getElementById(id);
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ],
  );
const pretty = (value) => JSON.stringify(value, null, 2);
const title = (value) =>
  String(value ?? '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .replace(/^./, (char) => char.toUpperCase());
const status = (value) =>
  `<span class="status ${escape(value)}">${escape(title(value))}</span>`;
let meta,
  current,
  source,
  view = 'board',
  selectedStep;
const personaDrafts = new Map();
async function api(path, body) {
  const result = await fetch(
    path,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Roleplay-Token': meta.csrf,
          },
          body: JSON.stringify(body),
        },
  );
  const data = await result.json();
  if (!result.ok) throw new Error(data.error ?? 'Request failed');
  return data;
}
function notice(message) {
  $('notice').textContent = message;
  $('notice').classList.toggle('hidden', !message);
}
function showView(next) {
  view = next;
  for (const name of ['board', 'timeline', 'events']) {
    $(name).classList.toggle('hidden', view !== name);
    $(`view-${name}`).classList.toggle('active', view === name);
  }
  $('nav-live').classList.toggle('selected', view === 'board');
  $('nav-timeline').classList.toggle('selected', view === 'timeline');
}
async function refreshRuns() {
  const runs = await api('/api/runs');
  $('run-list').innerHTML = runs.length
    ? runs
        .map(
          (run) =>
            `<button class="run-item ${run.id === current?.id ? 'active' : ''}" data-run="${escape(run.id)}"><strong>${escape(run.name)}</strong><small><span>${escape(run.target)}</span><span>${escape(title(run.status))}</span></small></button>`,
        )
        .join('')
    : '<p class="muted">Your campaigns will appear here.</p>';
}
function attach(run) {
  source?.close();
  current = run;
  render();
  refreshRuns();
  source = new EventSource(`/api/runs/${run.id}/events`);
  source.onmessage = (event) => {
    current = JSON.parse(event.data);
    render();
    if (
      !['preparing', 'running', 'paused', 'stopping'].includes(current.status)
    ) {
      source.close();
      refreshRuns();
    }
  };
  source.onerror = () => {
    $('connection').textContent = 'Reconnecting…';
  };
  source.onopen = () => {
    $('connection').textContent = 'Connected to local server';
  };
}
function bubble(turn) {
  return `<div class="bubble ${escape(turn.role)}"><span class="bubble-label">${turn.role === 'user' ? 'ACTOR' : 'SYSTEM'}</span>${escape(turn.text)}</div>`;
}
function render() {
  if (!current) return;
  $('welcome').classList.add('hidden');
  $('workspace').classList.remove('hidden');
  $('run-title').textContent = current.name;
  $('run-subtitle').textContent =
    `${current.campaign.scenarios.length} scenarios · ${current.roles.length} roles · up to ${current.campaign.concurrency} conversations at once`;
  $('run-status').outerHTML =
    `<span id="run-status" class="status ${escape(current.status)}">${escape(title(current.status))}</span>`;
  $('target-label').textContent = current.target;
  $('demo-label').classList.toggle('hidden', !current.demo);
  $('live-state').textContent = ['preparing', 'running'].includes(
    current.status,
  )
    ? 'Live updates'
    : title(current.status);
  $('pause-run').textContent = current.status === 'paused' ? 'Resume' : 'Pause';
  $('pause-run').disabled = !['running', 'paused'].includes(current.status);
  $('stop-run').disabled = !['running', 'paused', 'preparing'].includes(
    current.status,
  );
  $('export-run').href = `/api/runs/${current.id}/export`;
  const complete = current.steps.filter((step) =>
    ['passed', 'simulated'].includes(step.status),
  ).length;
  $('metric-actors').textContent = current.roles.length;
  $('metric-messages').textContent = current.steps.reduce(
    (sum, step) => sum + step.transcript.length,
    0,
  );
  $('metric-steps').textContent = `${complete} / ${current.steps.length}`;
  $('metric-waiting').textContent =
    `${current.steps.filter((step) => step.status === 'pending').length} waiting · ${current.modelCalls} model calls`;
  $('metric-issues').textContent = current.steps.filter((step) =>
    ['failed', 'unverified', 'outcome_unknown'].includes(step.status),
  ).length;
  const repairs = current.steps.filter((step) => step.repair);
  $('metric-repairs').textContent = repairs.length
    ? `${repairs.length} repair proposal${repairs.length === 1 ? '' : 's'} · ${repairs.filter((step) => step.repair.effectVerified).length} verified fixes`
    : 'No repair requests';
  if (current.demo)
    notice(
      'This is a deterministic local simulation. Conversations, outcomes and HAI proposals are illustrative; no real system was tested.',
    );
  else if (current.error) notice(current.error);
  else notice('');
  $('board').innerHTML = current.roles
    .map((role) => {
      const steps = current.steps.filter((step) => step.actorId === role.id);
      return `<section class="lane"><div class="lane-heading"><span class="avatar ${escape(role.id)}">${escape(role.name[0])}</span><span><strong>${escape(role.name)}</strong><small>${steps.length} step${steps.length === 1 ? '' : 's'} · isolated actor context</small></span><span class="count">${steps.reduce((n, step) => n + step.transcript.length, 0)}</span></div><div class="lane-content">${
        steps
          .map((step) => {
            const index = current.steps.indexOf(step);
            return `<article class="step-card" tabindex="0" role="button" data-step="${index}" aria-label="Inspect ${escape(title(step.id))}"><div class="step-card-top"><div><strong>${escape(title(step.id))}</strong><small>${escape(step.scenarioTitle)}</small></div>${status(step.status)}</div>${!step.transcript.length ? `<div class="step-goal">${escape(step.goal)}</div>` : step.transcript.slice(-4).map(bubble).join('')}${step.status === 'pending' ? `<div class="waiting-copy">↳ ${step.dependsOn.length ? `Waiting for ${escape(step.dependsOn.map(title).join(', '))}` : 'Ready when a lane is available'}</div>` : ''}${step.repair ? `<div class="repair-tag">✧ HAI · ${escape(title(step.repair.status))} · ${step.repair.effectVerified ? 'effect verified' : 'not a verified fix'}</div>` : ''}<div class="card-footer ${['failed', 'unverified', 'outcome_unknown'].includes(step.status) ? 'issue' : ''}"><span>${escape(step.error ?? step.judgment?.reason ?? (step.kind === 'fixture' ? 'QA fixture event' : 'No messages yet'))}</span><span>↗</span></div></article>`;
          })
          .join('') || '<p class="waiting-copy">No steps assigned yet.</p>'
      }</div></section>`;
    })
    .join('');
  $('timeline').innerHTML = current.campaign.scenarios
    .map(
      (scenario) =>
        `<section class="timeline-scenario"><h3>${escape(scenario.title)}</h3><p>World: ${escape(scenario.worldId)} · only verified dependency artifacts are shared</p><div class="timeline-steps">${current.steps
          .filter((step) => step.scenarioId === scenario.id)
          .map(
            (step) =>
              `<div class="timeline-step" data-step="${current.steps.indexOf(step)}" tabindex="0" role="button">${status(step.status)}<h4>${escape(title(step.id))}</h4><p>${escape(current.roles.find((role) => role.id === step.actorId).name)}</p><small>${step.dependsOn.length ? `Depends on: ${escape(step.dependsOn.map(title).join(', '))}` : 'Independent start'}</small>${step.kind === 'fixture' ? '<small>Explicit QA fixture · not a chat</small>' : ''}</div>`,
          )
          .join('')}</div></section>`,
    )
    .join('');
  $('events').innerHTML = [...current.events]
    .reverse()
    .map(
      (event) =>
        `<div class="event"><time>${escape(new Date(event.at).toLocaleTimeString())}</time><b>${escape(event.type)}</b><span>${escape([event.scenarioId, event.stepId, event.actorId].filter(Boolean).join(' / '))}</span>${event.status || event.verdict ? status(event.status ?? event.verdict) : ''}</div>`,
    )
    .join('');
  if ($('detail-dialog').open && selectedStep !== undefined)
    renderDetail(selectedStep);
}
function renderDetail(index) {
  selectedStep = index;
  const step = current.steps[index];
  $('detail-title').textContent = title(step.id);
  $('detail-label').textContent = step.scenarioTitle;
  $('detail-body').innerHTML =
    `<div class="detail-meta">${status(step.status)}<span>${escape(current.roles.find((role) => role.id === step.actorId).name)}</span><span>World ${escape(step.worldId)}</span></div><p class="muted">${escape(step.goal)}</p>${step.error ? `<pre>${escape(step.error)}</pre>` : ''}<section class="detail-section"><h3>Conversation</h3>${step.transcript.length ? step.transcript.map((turn) => `${bubble(turn)}${turn.judgment ? `<div class="detail-verdict">${escape(title(turn.judgment.verdict))} · ${escape(turn.judgment.reason)}</div>` : ''}`).join('') : '<p class="muted">No conversation messages. Fixture and blocked steps are recorded separately.</p>'}</section><section class="detail-section"><h3>Independent API verification</h3><ul class="check-list">${(step.verification?.checks ?? []).map((rule) => `<li><span class="${rule.passed ? 'check-pass' : 'check-fail'}">${rule.passed ? '✓' : '×'}</span>${escape(rule.label)}</li>`).join('') || '<li>No independent verification receipt yet.</li>'}</ul><details><summary>Observer evidence and shared artifacts</summary><pre>${escape(pretty({ verification: step.verification, sharedArtifacts: step.artifacts, conversationId: step.conversationId, pendingMessageId: step.pendingMessageId }))}</pre></details></section><section class="detail-section"><h3>HAI repair</h3>${step.repair ? `<p class="muted">${escape(step.repair.reason)}</p><pre>${escape(pretty(step.repair))}</pre>` : '<p class="muted">No repair requested. Correct permission denials are not capability gaps.</p>'}</section>`;
}
function openDesigner() {
  $('form-error').textContent = '';
  $('campaign-dialog').showModal();
}
function parsedRoles() {
  return $('campaign-roles')
    .value.split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const [id, name, ...description] = line
        .split('|')
        .map((part) => part.trim());
      if (!id || !name || !description.join('|'))
        throw new Error('Each role needs: identifier | name | description');
      const role = { id, name, description: description.join('|') };
      const persona = personaDrafts.get(JSON.stringify(role));
      return persona ? { ...role, persona } : role;
    });
}
async function plan(kind) {
  $('form-error').textContent = '';
  $('planning-state').textContent = 'Model is working…';
  $('enhance-roles').disabled = true;
  $('generate-plan').disabled = true;
  try {
    const result = await api(
      kind === 'enhance' ? '/api/roles/enhance' : '/api/plan',
      {
        target: $('campaign-target').value,
        name: $('campaign-name').value,
        brief: $('campaign-brief').value,
        roles: parsedRoles(),
      },
    );
    if (kind === 'enhance') {
      const roles = parsedRoles();
      if (!Array.isArray(result.roles) || result.roles.length !== roles.length)
        throw new Error('Enhancer changed the role count');
      for (const role of roles) {
        const enhanced = result.roles.find(
          (value) => value.id === role.id && value.name === role.name,
        );
        if (!enhanced?.persona || typeof enhanced.persona !== 'object')
          throw new Error('Enhancer did not preserve role identity');
        const { persona: _, ...base } = role;
        personaDrafts.set(JSON.stringify(base), enhanced.persona);
      }
      $('personas').textContent = pretty(parsedRoles());
      $('personas-panel').classList.remove('hidden');
      $('personas-panel').open = true;
    } else $('campaign-json').value = pretty(result);
    $('planning-state').textContent =
      kind === 'enhance'
        ? 'Personas added. They will be used in the run.'
        : 'Plan generated. Review before running.';
  } catch (error) {
    $('form-error').textContent = error.message;
    $('planning-state').textContent = '';
  } finally {
    $('enhance-roles').disabled = false;
    $('generate-plan').disabled = false;
  }
}
document
  .querySelectorAll('.new-run')
  .forEach((button) => button.addEventListener('click', openDesigner));
document
  .querySelectorAll('.close-dialog')
  .forEach((button) =>
    button.addEventListener('click', () => $('campaign-dialog').close()),
  );
$('close-detail').addEventListener('click', () => $('detail-dialog').close());
$('run-demo').addEventListener('click', async () => {
  try {
    attach(await api('/api/runs', meta.example));
  } catch (error) {
    notice(error.message);
  }
});
$('refresh-runs').addEventListener('click', () =>
  refreshRuns().catch((error) => notice(error.message)),
);
$('run-list').addEventListener('click', async (event) => {
  const item = event.target.closest('[data-run]');
  if (item)
    try {
      attach(await api(`/api/runs/${item.dataset.run}`));
    } catch (error) {
      notice(error.message);
    }
});
for (const name of ['board', 'timeline', 'events'])
  $(`view-${name}`).addEventListener('click', () => showView(name));
$('nav-live').addEventListener('click', () => showView('board'));
$('nav-timeline').addEventListener('click', () => showView('timeline'));
for (const name of ['board', 'timeline']) {
  const inspect = (event) => {
    const item = event.target.closest('[data-step]');
    if (item) {
      renderDetail(Number(item.dataset.step));
      $('detail-dialog').showModal();
    }
  };
  $(name).addEventListener('click', inspect);
  $(name).addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      inspect(event);
    }
  });
}
$('pause-run').addEventListener('click', async () => {
  try {
    current = await api(`/api/runs/${current.id}/control`, {
      command: current.status === 'paused' ? 'resume' : 'pause',
    });
    render();
  } catch (error) {
    notice(error.message);
  }
});
$('stop-run').addEventListener('click', async () => {
  try {
    current = await api(`/api/runs/${current.id}/control`, { command: 'stop' });
    render();
  } catch (error) {
    notice(error.message);
  }
});
$('enhance-roles').addEventListener('click', () => plan('enhance'));
$('generate-plan').addEventListener('click', () => plan('plan'));
$('campaign-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('form-error').textContent = '';
  try {
    const campaign = JSON.parse($('campaign-json').value);
    campaign.target = $('campaign-target').value;
    campaign.name = $('campaign-name').value;
    campaign.roles = parsedRoles();
    const run = await api('/api/runs', campaign);
    $('campaign-dialog').close();
    attach(run);
  } catch (error) {
    $('form-error').textContent = error.message;
  }
});
try {
  meta = await api('/api/meta');
  $('campaign-target').innerHTML = meta.targets
    .map(
      (target) =>
        `<option value="${escape(target.id)}">${escape(target.label)}</option>`,
    )
    .join('');
  $('campaign-roles').value = meta.example.roles
    .map((role) => `${role.id} | ${role.name} | ${role.description}`)
    .join('\n');
  $('campaign-json').value = pretty(meta.example);
  await refreshRuns();
} catch (error) {
  notice(`Cannot reach the local lab: ${error.message}`);
}
