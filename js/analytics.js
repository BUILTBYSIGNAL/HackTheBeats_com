// Google Analytics, on unless the visitor opts out. A first visit shows a notice saying so,
// with an Opt out button; the answer is remembered in this browser, and can be changed from
// the privacy page. A browser that sends the Global Privacy Control signal is taken as
// having opted out. The shared-song player never loads it.
import { config, site } from './config.js';

const KEY = 'hacking-the-beats:analytics';
const id = site.guest ? null : config.analytics || null;
let loaded = false;
// the name Google is given for this page (see `page` below)
let pageTitle = null;

const read = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};
const remember = (answer) => {
  try {
    localStorage.setItem(KEY, answer);
  } catch {
    /* the notice will be shown again next time */
  }
};
// "no" if they opted out here, or their browser asks every site not to track them
const optedOut = () => {
  const answer = read();
  return answer === 'no' || (answer !== 'yes' && navigator.globalPrivacyControl === true);
};

function load() {
  window[`ga-disable-${id}`] = false;
  if (loaded) return;
  loaded = true;
  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() {
    window.dataLayer.push(arguments);
  };
  window.gtag('js', new Date());
  // said before the first hit: by the time Google's script reads the tab's own title, it
  // may be the title of someone's song
  window.gtag('set', { page_title: pageTitle ?? document.title });
  window.gtag('config', id);
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
  document.head.append(script);
}

// Opting out: stop sending, and remove the cookies Google set.
function stop() {
  window[`ga-disable-${id}`] = true;
  const names = document.cookie.split(';').map((cookie) => cookie.split('=')[0].trim()).filter((name) => name === '_ga' || name.startsWith('_ga_'));
  const host = location.hostname;
  for (const name of names) {
    for (const domain of ['', `; domain=${host}`, `; domain=.${host.split('.').slice(-2).join('.')}`]) document.cookie = `${name}=; Max-Age=0; path=/${domain}`;
  }
}

// The notice: what is counted, and the way out. For someone who has opted out it offers
// the way back in instead.
function notice() {
  document.querySelector('.consent')?.remove();
  const off = optedOut();
  const banner = document.createElement('div');
  banner.className = 'consent';
  banner.setAttribute('role', 'region');
  banner.setAttribute('aria-label', 'Analytics');
  banner.innerHTML = off
    ? `<span>Google Analytics is off for you in this browser. <a href="privacy" target="_blank" rel="noopener">Privacy</a></span>
    <span class="consent__actions">
      <button type="button" data-answer="no">Keep it off</button>
      <button type="button" data-answer="yes">Turn it on</button>
    </span>`
    : `<span>We count visits with Google Analytics, which uses cookies. <a href="privacy" target="_blank" rel="noopener">Privacy</a></span>
    <span class="consent__actions">
      <button type="button" data-answer="yes">OK</button>
      <button type="button" data-answer="no">Opt out</button>
    </span>`;
  banner.addEventListener('click', (event) => {
    const answer = event.target.closest?.('[data-answer]')?.dataset.answer;
    if (!answer) return;
    remember(answer);
    banner.remove();
    if (answer === 'yes') load();
    else stop();
  });
  // on the player it takes a row of its own above the footer; elsewhere it floats
  const footer = document.querySelector('body > .sitefoot');
  if (footer) footer.before(banner);
  else document.body.append(banner);
}

export const analytics = {
  available: Boolean(id),
  // On every page load: count the visit unless they opted out, and say so the first time.
  start() {
    if (!id) return;
    if (optedOut()) return;
    load();
    if (read() === null) notice();
  },
  // Show the notice again, to change the answer (from the privacy page).
  ask() {
    if (id) notice();
  },
  // What Google is told this page is called. Left alone it would read the tab's title,
  // which can be the title of the listener's own song; that stays here.
  page(title) {
    pageTitle = title;
    if (loaded) window.gtag('set', { page_title: title });
  },
  event(name, params = {}) {
    if (loaded && !window[`ga-disable-${id}`]) window.gtag('event', name, params);
  },
};
