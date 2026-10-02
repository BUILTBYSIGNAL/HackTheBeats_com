// Refuses to let private things into the public repository. Run by `npm run check:public`,
// by CI on every push, and (if you install it) by git before each push:
//
//   printf '#!/bin/sh\nexec node tools/check-public.mjs\n' > .git/hooks/pre-push && chmod +x .git/hooks/pre-push
//
// It looks at every file git tracks, or is about to (`git ls-files -co --exclude-standard`):
//   - beats/ may hold only the demo songs. Songs dropped in there are yours, not the project's.
//   - no site settings (config.site.json, .firebaserc), credentials or key files
//   - no API keys, private keys or access tokens in any file
//   - no e-mail addresses other than made-up ones, and no paths into someone's home folder
//     (this machine's own home folder is looked for in every file, bundles and pictures too)
//   - none of the words in .private-terms, if that file exists: one per line, for anything
//     else that must stay on this machine (a name, an account id, a song title). That file
//     is ignored by git, so the list itself is never published. A git worktree uses the
//     list in the main checkout.
//
// Where .private-terms exists, the commits that are not on the remote yet are held to it as
// well, because a push publishes them whole: who each one says made it, what its message
// says, and every file in it, including one that has been deleted or cleaned up since.
// Without the list (CI, anyone else's copy) none of that is looked at, so a contributor's
// own name and address never fail a check.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// git's answer as text; `quiet` is for commands that exit 1 to say "nothing found"
const git = (args, { quiet = false } = {}) => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
  } catch (error) {
    if (quiet && error.status === 1) return '';
    throw error;
  }
};
const files = git(['ls-files', '-co', '--exclude-standard', '-z']).split('\0').filter(Boolean);

const DEMOS = new Set(['beats/demo-first-light.strudel', 'beats/demo-low-tide.strudel', 'beats/demo-clockwork.strudel']);
const FORBIDDEN_FILES = [
  [/^config\.site\.json$/, "this site's settings"],
  [/^\.firebaserc$/, 'the Firebase project'],
  [/(^|\/)\.env(\..*)?$/, 'an environment file'],
  [/\.(pem|key|p12|pfx)$/i, 'a key file'],
  [/(service-account|adminsdk).*\.json$/i, 'a service account'],
  [/^\.claude\//, 'local tool settings'],
  [/^private\//, 'notes and drafts'],
  [/^(dist|node_modules|vendor\/samples)\//, 'generated or downloaded files'],
];
const SECRETS = [
  [/AIza[0-9A-Za-z_-]{35}/, 'a Google API key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'a GitHub token'],
  [/\bya29\.[A-Za-z0-9_-]{20,}/, 'a Google access token'],
  [/\b1\/\/[0-9A-Za-z_-]{40,}/, 'a Google refresh token'],
  [/\bGOCSPX-[A-Za-z0-9_-]{20,}/, 'an OAuth client secret'],
  [/\bG-[A-Z0-9]{10}\b/, 'an analytics measurement id'],
  [/\b\d{1,2}:\d{10,14}:web:[0-9a-f]{16,}/, 'a Firebase app id'],
  [/\/(Users|home)\/[a-z][a-z0-9_-]+\//, "a path into someone's home folder"],
];
// addresses that are allowed to appear: made-up ones, and the ones tools sign with
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/g;
const EMAIL_OK = /@(example\.(com|org|net)|users\.noreply\.github\.com|anthropic\.com)$/i;
// third-party code and the licence text are not ours to rewrite
const NOT_OURS = (path) => path.startsWith('vendor/') || /(^|\/)package-lock\.json$/.test(path) || path === 'LICENSE' || /^functions\/fonts\/.*-OFL\.txt$/.test(path);
const BINARY = /\.(png|jpe?g|gif|ico|woff2?|ttf|otf|wav|mp3|ogg|flac|gz|zip|pdf)$/i;

// A worktree has no list of its own (git ignores the file), so the one in the main
// checkout stands for every worktree of it.
const mainCheckout = dirname(resolve(root, git(['rev-parse', '--git-common-dir']).trim()));
const termsFile = [root, mainCheckout].map((dir) => join(dir, '.private-terms')).find((file) => existsSync(file));
const terms = termsFile
  ? readFileSync(termsFile, 'utf8').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
  : [];

// this machine's own home folder (/Users/someone, /home/someone)
const home = homedir();
const hasHome = home.split('/').filter(Boolean).length >= 2;

const problems = [];
for (const path of files) {
  if (path.startsWith('beats/') && !DEMOS.has(path)) problems.push(`${path}: only the demo songs belong in beats/`);
  for (const [pattern, what] of FORBIDDEN_FILES) if (pattern.test(path)) problems.push(`${path}: ${what} must not be published`);
  if (!existsSync(join(root, path))) continue;
  const bytes = readFileSync(join(root, path));
  // in any file at all: a bundle or a picture made on this machine can carry it too
  if (hasHome && bytes.includes(home)) problems.push(`${path}: contains the path of this machine's home folder`);
  if (BINARY.test(path)) continue;
  const text = bytes.toString('utf8');
  const lines = text.split('\n');
  const where = (index) => `${path}:${text.slice(0, index).split('\n').length}`;
  for (const term of terms) {
    const index = text.toLowerCase().indexOf(term.toLowerCase());
    if (index >= 0) problems.push(`${where(index)}: contains a word from .private-terms`);
  }
  if (NOT_OURS(path)) continue;
  for (const [pattern, what] of SECRETS) {
    const found = pattern.exec(text);
    if (found) problems.push(`${where(found.index)}: looks like ${what}`);
  }
  lines.forEach((line, i) => {
    for (const address of line.match(EMAIL) || []) {
      if (!EMAIL_OK.test(address)) problems.push(`${path}:${i + 1}: an e-mail address (use one at example.org)`);
    }
  });
}

/* ---------- commits that are not on the remote yet ---------- */

const has = (text, term) => text.toLowerCase().includes(term.toLowerCase());
let unpushed = [];
if (terms.length) {
  // every commit on a local branch or tag that no remote has
  const range = ['--branches', '--tags', '--not', '--remotes'];
  unpushed = git(['rev-list', ...range]).split('\n').filter(Boolean);
  const short = (id) => id.slice(0, 7);
  // who made it and what it says: fields end in \x1f, commits in \x1e
  for (const record of unpushed.length ? git(['log', ...range, '--format=%H%x1f%an <%ae>%x1f%cn <%ce>%x1f%B%x1e']).split('\x1e') : []) {
    const [id, author, committer, message] = record.trim().split('\x1f');
    if (!id) continue;
    if (terms.some((term) => has(author, term) || has(committer, term))) {
      problems.push(`commit ${short(id)}: is signed with a word from .private-terms (set this copy's user.name and user.email to public ones, then: git commit --amend --reset-author)`);
    }
    if (terms.some((term) => has(message, term))) problems.push(`commit ${short(id)}: its message contains a word from .private-terms`);
  }
  // an annotated tag is signed and worded too
  for (const record of git(['for-each-ref', 'refs/tags', '--format=%(objecttype)%1f%(refname:short)%1f%(taggername) %(taggeremail)%1f%(contents)%1e']).split('\x1e')) {
    const [type, name, tagger, message] = record.trim().split('\x1f');
    if (type === 'tag' && terms.some((term) => has(tagger, term) || has(message, term))) problems.push(`tag ${name}: is signed or worded with a word from .private-terms`);
  }
  // every file in those commits, as it was then
  const patterns = terms.flatMap((term) => ['-e', term]);
  for (let i = 0; i < unpushed.length; i += 50) {
    const found = git(['grep', '-l', '-i', '-a', '-F', ...patterns, ...unpushed.slice(i, i + 50), '--'], { quiet: true });
    for (const line of found.split('\n').filter(Boolean)) {
      const at = line.indexOf(':');
      problems.push(`commit ${short(line.slice(0, at))}: ${line.slice(at + 1)} contains a word from .private-terms there, even if the file has changed since`);
    }
  }
}

if (problems.length) {
  console.error(`✗ ${problems.length} thing(s) that must not be published:\n`);
  for (const problem of [...new Set(problems)]) console.error(`  ${problem}`);
  console.error('\nNothing was changed. Fix these, then run this again.');
  process.exit(1);
}
const looked = [`${files.length} files checked`, terms.length ? `${terms.length} private words` : null, unpushed.length ? `${unpushed.length} commit(s) not yet pushed` : null].filter(Boolean);
console.log(`✓ ${looked.join(', ')}: nothing private`);
