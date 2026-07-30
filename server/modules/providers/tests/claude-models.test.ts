import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLAUDE_FALLBACK_MODELS,
  ClaudeProviderModels,
  findClaudeModelOption,
} from '@/modules/providers/list/claude/claude-models.provider.js';

test('Claude models provider returns confirmed fallback aliases with default default', async () => {
  const provider = new ClaudeProviderModels();
  const definition = await provider.getSupportedModels();

  assert.equal(definition.DEFAULT, 'default');
  const values = definition.OPTIONS.map((opt) => opt.value);
  assert.deepEqual(values, ['default', 'fable', 'sonnet', 'sonnet[1m]', 'opus', 'opus[1m]', 'haiku']);
});

test('Claude catalog includes all expected aliases', () => {
  const values = CLAUDE_FALLBACK_MODELS.OPTIONS.map((opt) => opt.value);

  assert.ok(values.includes('default'), 'default must be present');
  assert.ok(values.includes('sonnet'), 'sonnet must be present');
  assert.ok(values.includes('opus'), 'opus must be present');
  assert.ok(values.includes('haiku'), 'haiku must be present');
  assert.ok(values.includes('sonnet[1m]'), 'sonnet[1m] must be present');
  assert.ok(values.includes('opus[1m]'), 'opus[1m] must be present');
});

test('Claude catalog default is "default"', () => {
  assert.equal(CLAUDE_FALLBACK_MODELS.DEFAULT, 'default');

  const defaultOption = CLAUDE_FALLBACK_MODELS.OPTIONS.find((opt) => opt.value === 'default');
  assert.ok(defaultOption, 'default option must exist');
});

test('Claude catalog labels do not contain hardcoded model version numbers', () => {
  const versionPattern = /\b\d+\.\d+\b/;

  for (const option of CLAUDE_FALLBACK_MODELS.OPTIONS) {
    assert.ok(
      !versionPattern.test(option.label),
      `label "${option.label}" must not contain a hardcoded version number`,
    );
    if (option.description) {
      assert.ok(
        !versionPattern.test(option.description),
        `description "${option.description}" must not contain a hardcoded version number`,
      );
    }
  }
});

test('Claude model lookup finds known aliases', () => {
  assert.equal(findClaudeModelOption('sonnet')?.value, 'sonnet');
  assert.equal(findClaudeModelOption('fable')?.value, 'fable');
  assert.equal(findClaudeModelOption('sonnet[1m]')?.value, 'sonnet[1m]');
  assert.equal(findClaudeModelOption('opus[1m]')?.value, 'opus[1m]');
  assert.equal(findClaudeModelOption('unknown-model'), null);
});
