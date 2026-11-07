#!/usr/bin/env node
/** CLI: a local dashboard, one bounded campaign, or JSON campaign validation. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLab } from './server.mjs';
import { validateCampaign } from './contracts.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const configPath = option('--config', process.env.ROLEPLAY_CONFIG);
const config = configPath
  ? JSON.parse(readFileSync(resolve(configPath), 'utf8'))
  : {};
const command = args[0] ?? 'serve';
try {
  if (command === 'validate') {
    const campaign = validateCampaign(
      JSON.parse(readFileSync(resolve(args[1]), 'utf8')),
    );
    console.log(
      JSON.stringify({
        valid: true,
        roles: campaign.roles.length,
        scenarios: campaign.scenarios.length,
      }),
    );
  } else {
    const lab = createLab(config, {
      directory: resolve(option('--runs', '.roleplay-runs')),
    });
    if (command === 'run') {
      const campaign = JSON.parse(readFileSync(resolve(args[1]), 'utf8'));
      if (args.includes('--demo')) campaign.target = 'demo';
      const run = await lab.launch(campaign);
      run.on('update', (snapshot) => {
        const event = snapshot.events.at(-1);
        if (['step.finished', 'run.finished'].includes(event?.type))
          console.log(JSON.stringify(event));
      });
      const result = await run.completion;
      console.log(
        JSON.stringify({
          id: result.id,
          status: result.status,
          demo: result.demo,
          qualified: result.qualified,
          summary: result.summary,
        }),
      );
      process.exitCode = result.status === 'completed' ? 0 : 1;
      lab.dispose();
    } else {
      if (command !== 'serve')
        throw new Error(
          'Use serve, run <campaign.json>, or validate <campaign.json>',
        );
      const port = Number(option('--port', process.env.PORT ?? 4318));
      lab.server.listen(port, '127.0.0.1', () =>
        console.log(
          `Conversation Roleplay: http://127.0.0.1:${lab.server.address().port}`,
        ),
      );
      const shutdown = () => {
        for (const run of lab.runs.values()) run.stop();
        lab.server.close();
        setTimeout(() => process.exit(0), 3000).unref();
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
