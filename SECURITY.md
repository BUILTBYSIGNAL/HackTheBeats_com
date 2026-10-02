# Security

## Reporting a problem

Please report a vulnerability privately, not in a public issue:

**[Report a vulnerability](https://github.com/BUILTBYSIGNAL/hackthebeats_com/security/advisories/new)**
(the repository's Security tab → Report a vulnerability).

Say what you found, how to reproduce it, and what it lets someone do. You will get an answer, and credit in the
fix if you would like it. Please give us a reasonable time to fix a problem before telling anyone else, and do not
read, change or delete other people's data while looking.

## What counts

Anything that breaks a promise the site makes:

- reading or changing another person's songs, or finding a private song
- a shared song acting as the person listening to it
- reading a beat that has not been opened to you, or becoming an admin
- a secret, credential or personal detail in this repository

The rules that enforce those promises are in [`firestore.rules`](firestore.rules), and the README's
[security model](README.md#security-model) explains them.

## What does not

The Firebase web config a site sends to every browser (its `apiKey`, `projectId` and `appId`) identifies the
project and is not a secret. It is kept out of this repository anyway.
