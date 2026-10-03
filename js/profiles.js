// Keeps the signed-in person's profile (profiles-core.js) up to date: when they arrive, and
// when how many songs they have, or share, changes. It is what the admin's People list
// reads; it holds a name, two dates and two numbers.
import { cloud } from './cloud.js';
import { songs } from './songs.js';
import { profileFrom, sameProfile } from './profiles-core.js';

// the profile as the database holds it: undefined until it has been read
let saved;
// the account's songs have been read since signing in, so the counts are the account's
let ready = false;
let timer;

export const profiles = {
  start() {
    if (!cloud.accounts) return;
    cloud.onUser(() => {
      saved = undefined;
      ready = false;
      clearTimeout(timer);
    });
    songs.onChange((reason) => {
      if (reason === 'signed-in') ready = true;
      if (ready && cloud.user) this.queue();
    });
  },

  // A burst of changes (a sign-in, an import) is written once.
  queue() {
    clearTimeout(timer);
    timer = setTimeout(() => this.save().catch((error) => console.warn('[profiles] could not save', error)), 2000);
  },

  async save() {
    const user = cloud.user;
    if (!user) return;
    if (saved === undefined) saved = await cloud.getProfile();
    const next = profileFrom(user.displayName, songs.list(), saved);
    if (sameProfile(saved, next) || cloud.user !== user) return;
    await cloud.saveProfile(next);
    saved = next;
  },
};
