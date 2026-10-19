import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let loaded;
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition;
    },
  },
};

await import('../client.js');
const host = await import('../index.js');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('client bundle registers under the package name and returns a Cordis plugin', () => {
  assert.equal(loaded.id, 'dsh-retry');
  const plugin = loaded.factory(() => {
    throw new Error('skeleton loads no modules');
  });
  assert.equal(typeof plugin.apply, 'function');
  // 只硬依赖渲染层与词典；其余服务由 apply 里的 ctx.get 可选读取。
  assert.deepEqual(plugin.inject, ['slots', 'locale']);
});

test('host entry exposes a Cordis plugin shape', () => {
  assert.equal(typeof host.apply, 'function');
  assert.ok(Array.isArray(host.inject));
});

test('manifest carries the fields the client module loader reads', () => {
  assert.equal(manifest.name, 'dsh-retry');
  assert.equal(manifest.exports['./client'], './client.js');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.ok(existsSync(join(root, 'client.js')));
  assert.ok(existsSync(join(root, 'cordis.patch.yml')));
});

test('bundle patch inserts this package', () => {
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /id: retry/);
  assert.match(patch, /name: dsh-retry/);
});

test('locale files carry the plugin meta the manager reads', () => {
  for (const lang of ['en', 'zh']) {
    const meta = JSON.parse(readFileSync(join(root, 'locale', `${lang}.json`), 'utf8')).meta;
    assert.equal(typeof meta.title, 'string');
    assert.ok(meta.title.length > 0);
    assert.equal(typeof meta.description, 'string');
    assert.ok(meta.description.length > 0);
  }
});
