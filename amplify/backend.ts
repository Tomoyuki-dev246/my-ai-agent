import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';
import { createAgentCoreRuntime } from './agent/resource';

const backend = defineBackend({
  auth,
});

const agentCoreStack = backend.createStack('AgentCoreStack');

const { runtime } = createAgentCoreRuntime(
  agentCoreStack,
  backend.auth.resources.userPool,
  backend.auth.resources.userPoolClient
);

backend.addOutput({
  custom: {
    agentRuntimeArn: runtime.agentRuntimeArn,
  },
});
