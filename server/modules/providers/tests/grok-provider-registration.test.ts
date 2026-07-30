import assert from 'node:assert/strict';
import test from 'node:test';

import { GrokProviderAuth } from '@/modules/providers/list/grok/grok-auth.provider.js';
import { GrokMcpProvider } from '@/modules/providers/list/grok/grok-mcp.provider.js';
import { GrokProviderModels } from '@/modules/providers/list/grok/grok-models.provider.js';
import { grokRuntime } from '@/modules/providers/list/grok/grok-runtime.provider.js';
import { GrokSessionSynchronizer } from '@/modules/providers/list/grok/grok-session-synchronizer.provider.js';
import { GrokProviderSessions } from '@/modules/providers/list/grok/grok-sessions.provider.js';
import { GrokSkillsProvider } from '@/modules/providers/list/grok/grok-skills.provider.js';
import { GrokProvider } from '@/modules/providers/list/grok/grok.provider.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { providerCapabilitiesService } from '@/modules/providers/services/provider-capabilities.service.js';

test('GrokProvider aggregate class', async (t) => {
  await t.test('instantiates with id "grok" and all seven expected facets', () => {
    const provider = new GrokProvider();
    assert.equal(provider.id, 'grok');
    assert.equal(provider.runtime, grokRuntime);
    assert(provider.models instanceof GrokProviderModels);
    assert(provider.mcp instanceof GrokMcpProvider);
    assert(provider.auth instanceof GrokProviderAuth);
    assert(provider.skills instanceof GrokSkillsProvider);
    assert(provider.sessions instanceof GrokProviderSessions);
    assert(provider.sessionSynchronizer instanceof GrokSessionSynchronizer);
  });
});

test('providerRegistry Grok integration', async (t) => {
  await t.test('resolves Grok provider by "grok" id', () => {
    const resolved = providerRegistry.resolveProvider('grok');
    assert.equal(resolved.id, 'grok');
    assert(resolved instanceof GrokProvider);
    assert.equal(resolved.runtime, grokRuntime);
  });

  await t.test('lists Grok provider exactly once among all registered providers', () => {
    const allProviders = providerRegistry.listProviders();
    const grokMatches = allProviders.filter((p) => p.id === 'grok');
    assert.equal(grokMatches.length, 1);
    assert(grokMatches[0] instanceof GrokProvider);

    const providerIds = allProviders.map((p) => p.id);
    assert.deepEqual(providerIds, ['claude', 'codex', 'cursor', 'opencode', 'antigravity', 'grok']);
  });
});

test('providerCapabilitiesService Grok capabilities', async (t) => {
  await t.test('returns exact Grok capabilities record', () => {
    const capabilities = providerCapabilitiesService.getProviderCapabilities('grok');
    assert.deepEqual(capabilities, {
      provider: 'grok',
      permissionModes: [
        'default',
        'acceptEdits',
        'auto',
        'dontAsk',
        'bypassPermissions',
        'plan',
      ],
      defaultPermissionMode: 'default',
      supportsImages: false,
      supportsFiles: false,
      supportsAbort: true,
      supportsPermissionRequests: false,
      supportsTokenUsage: false,
      supportsEffort: false,
    });
  });

  await t.test('lists Grok capabilities exactly once in listAllProviderCapabilities', () => {
    const allCapabilities = providerCapabilitiesService.listAllProviderCapabilities();
    const grokCapabilities = allCapabilities.filter((c) => c.provider === 'grok');
    assert.equal(grokCapabilities.length, 1);
    assert.equal(grokCapabilities[0].supportsAbort, true);
    assert.equal(grokCapabilities[0].supportsImages, false);
    assert.equal(grokCapabilities[0].supportsFiles, false);
    assert.equal(grokCapabilities[0].supportsTokenUsage, false);
    assert.equal(grokCapabilities[0].supportsEffort, false);
    assert.deepEqual(grokCapabilities[0].permissionModes, [
      'default',
      'acceptEdits',
      'auto',
      'dontAsk',
      'bypassPermissions',
      'plan',
    ]);

    const registeredProviders = allCapabilities.map((c) => c.provider);
    assert.deepEqual(registeredProviders, ['claude', 'cursor', 'codex', 'opencode', 'antigravity', 'grok']);
  });
});
