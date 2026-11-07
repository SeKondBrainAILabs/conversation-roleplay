/** Public embedding interface for product CI and custom adapters. */
export { CampaignRun } from './engine.mjs';
export { RunStore } from './store.mjs';
export { JsonChatModel, DemoModel } from './model.mjs';
export {
  HttpConversationAdapter,
  DemoConversationAdapter,
  createAdapter,
} from './adapters.mjs';
export {
  HaiRepairAdapter,
  validateProposal,
  validateRepairContract,
} from './repair.mjs';
export { validateCampaign, validateGeneratedCampaign } from './contracts.mjs';
export { createLab } from './server.mjs';
export {
  CoreAiModel,
  CoreBackendClient,
  ServiceCredentials,
  createServiceStack,
} from './services.mjs';
