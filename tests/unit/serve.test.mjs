import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// The dev server serves the project folder, which on a working machine holds songs and
// settings that are nobody else's business. These check that it keeps them to itself.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let server;
let port;

const freePort = () =>
  new Promise((done) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const found = probe.address().port;
      probe.close(() => done(found));
    });
  });

// The status a request gets, or the error code if nothing answers.
const ask = (path, { host = '127.0.0.1', headers = {} } = {}) =>
  new Promise((done) => {
    const request = http.get({ host, port, path, headers, timeout: 1500 }, (response) => {
      response.resume();
      response.on('end', () => done(response.statusCode));
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('no answer'), { code: 'TIMEOUT' })));
    request.on('error', (error) => done(error.code));
  });

before(async () => {
  port = await freePort();
  server = spawn(process.execPath, [resolve(root, 'tools/serve.mjs')], { env: { ...process.env, PORT: String(port), SERVE_HOST: '', SERVE: '' }, stdio: 'ignore' });
  for (let i = 0; i < 50 && (await ask('/')) !== 200; i++) await new Promise((done) => setTimeout(done, 100));
});
after(() => server.kill());

test('serves the site to this machine, by either of its names', async () => {
  assert.equal(await ask('/'), 200);
  assert.equal(await ask('/about'), 200);
  assert.equal(await ask('/', { headers: { Host: `localhost:${port}` } }), 200);
});

test("a shared song's own address is the player, as on the hosted site", async () => {
  assert.equal(await ask('/s/0b9c7a1e-4f3d-4c2b-9a8e-1d2c3b4a5f6e'), 200);
  assert.equal(await ask('/s/not-a-link'), 404);
});

test('never hands out a dotfile, the site settings or an emulator log', async () => {
  // (.gitignore and the example settings are in every copy, so a refusal here is a real one)
  assert.equal(await ask('/config.site.example.json'), 200);
  for (const path of ['/.gitignore', '/.GITIGNORE', '/%2egitignore', '/.github/workflows/ci.yml', '/.git/HEAD', '/.private-terms', '/.firebaserc', '/config.site.json', '/Config.Site.JSON', '/firestore-debug.log']) {
    assert.equal(await ask(path), 404, path);
  }
});

test('answers only to its own names, so another site cannot borrow it', async () => {
  assert.equal(await ask('/', { headers: { Host: 'example.org' } }), 403);
  assert.equal(await ask('/', { headers: { Host: `example.org:${port}` } }), 403);
});

test('cannot be reached from the network', async () => {
  const outside = Object.values(networkInterfaces())
    .flat()
    .filter((address) => address.family === 'IPv4' && !address.internal)
    .map((address) => address.address);
  for (const host of outside) {
    const answer = await ask('/', { host, headers: { Host: `localhost:${port}` } });
    assert.ok(typeof answer === 'string', `${host} answered ${answer}`);
  }
});
