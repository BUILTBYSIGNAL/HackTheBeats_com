// Site configuration. Everything here is optional: left empty, the site runs with no
// accounts, keeps songs in the browser and plays the beats in beats/.
//
// A real site's values do not belong in this file. Put them in config.site.json at the top
// of the project (see config.site.example.json): the dev server and the build hand them to
// the page as window.HTB_CONFIG, through site-config.js. Tests set window.HTB_CONFIG
// themselves before the page loads.
export const config = {
  // Accounts need `firebase` to hold the web app config from the Firebase console
  // (Project settings → Your apps → SDK setup and configuration): apiKey, authDomain,
  // projectId, appId. Those values identify the project; they are not secrets, and access
  // is enforced by firestore.rules. Null switches accounts off.
  // With `authDomain` set to the site's own domain, Google's sign-in screen names the site
  // (https://<domain>/__/auth/handler must be an authorized redirect on the OAuth client).
  firebase: null,

  // Where the site lives, and the second address that plays shared songs. A song is code,
  // so someone else's song is opened on `shareOrigin`: the same files on a different
  // origin, where nobody is signed in and there is nothing of the listener's to reach.
  // With either left empty, shared songs open here behind a "run this?" question instead.
  // `appOrigin` is also the address search engines are told each page lives at.
  appOrigin: '',
  shareOrigin: '',

  // Shown in the privacy notice and the About panel. Needed before accounts go public.
  contact: '',

  // Google Analytics measurement id. On unless a visitor opts out (js/analytics.js).
  analytics: '',

  // Local emulators, used by the tests: { auth: 'http://127.0.0.1:9099', firestore: ['127.0.0.1', 8080] }
  emulators: null,

  ...globalThis.HTB_CONFIG,
};

// An address as a browser writes an origin: "https://example.org/" is "https://example.org".
const originOf = (address) => {
  try {
    return new URL(address).origin;
  } catch {
    return '';
  }
};

// Where a page is, given the site's two addresses. Plain logic, so the tests can ask it
// about any address.
//   `split`: the two-address setup is in force for this page (it is not on localhost, say).
//   `guest`: this page is the shared-song player — no accounts, no songs of one's own.
//   `stray`: the site's files are answering at some other address on the internet (the
//     host's own <project>.web.app name, say), where nothing would keep a shared song
//     apart from the listener's account. It holds the address such a page is sent to
//     instead (js/main.js), and is empty everywhere else.
export function placeOf({ appOrigin, shareOrigin }, { origin = '', hostname = '' } = {}) {
  const [home, player] = [appOrigin, shareOrigin].map(originOf);
  const paired = Boolean(home && player && home !== player);
  const split = paired && (origin === home || origin === player);
  // a copy on this machine or this network: a name ending in localhost, or a bare number
  const local = !hostname || /(^|\.)localhost$/.test(hostname) || /^[\d.]+$/.test(hostname) || hostname.startsWith('[');
  return { split, guest: split && origin === player, stray: paired && !split && !local ? home : '' };
}

export const site = placeOf(config, globalThis.location);
