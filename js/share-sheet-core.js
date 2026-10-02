// What the share sheet says for one song, as plain data: which warning, whether there is a
// sharing switch, the link and what is said under it, and what the person who gets the
// link will find. No imports, so every case is unit-tested in Node.
//
//   kind       'own' (one of my songs), 'beat' (a built-in beat), 'theirs' (someone
//              else's shared song, on the main site), 'loose' (a song no longer in My songs)
//   edited     the code on the deck differs from the saved song
//   dismissed  the person chose to share without their changes
//   accounts   sharing one's own songs is possible here (a hosted site with accounts)
//   shared, blocked, synced   the song's own state (own songs)
//   busy       the link is being made
//   link       the address to share, once there is one
//   audience   who can play a built-in beat: 'everyone', 'members' or 'admin'
//   title, host, sharer, ownerName   words for the sentences
export function sheetState(s) {
  // intro: what is being shared, when that is not obvious; offer: the better way to share it
  const out = { intro: '', warning: null, offer: null, toggle: null, link: null, recipient: '', note: '' };
  const warn = (text, primary, secondary = null) => (s.dismissed ? null : { text, primary, secondary });

  if (s.kind === 'own') {
    if (!s.accounts) {
      out.note = 'Sharing a song of your own needs accounts, on a hosted copy of the site.';
      return out;
    }
    out.toggle = { on: Boolean(s.shared) && !s.blocked, disabled: Boolean(s.blocked || s.busy) };
    if (s.blocked) {
      out.note = 'The site switched sharing off for this song.';
      return out;
    }
    if (s.edited) out.warning = warn('You have changes that are not saved. The link plays the last saved version.', { label: 'Save and share', action: 'save-share' }, { label: 'Share the saved version', action: 'dismiss' });
    if (!s.shared) {
      out.recipient = 'Switch it on for a link. Anyone who has the link can play your song; nobody else can find it.';
      return out;
    }
    out.link = s.busy || !s.link ? { pending: true, text: 'Making the link…', note: '' } : { text: s.link, note: 'The link always plays the latest saved version.' };
    if (!s.busy && s.link && !s.synced) out.link.note = 'Your account could not be reached just now: the link will work once the song has been saved there.';
    const by = s.sharer ? `, shared by ${s.sharer}` : '';
    out.recipient = `They will find "${s.title}" on ${s.host}${by}, with its knobs, channels and pads to play with. They can't change your song, but they can keep a copy of their own that credits you.`;
    return out;
  }

  // One of the site's beats. The better link is to a copy of one's own, which carries its own
  // preview; the beat's own link only works for the people who can play the beat.
  if (s.kind === 'beat') {
    out.intro = `"${s.title}" is one of the site's beats, not a song of yours.`;
    if (s.accounts) {
      out.offer = {
        text: `Keep your own copy${s.edited ? ', with your changes,' : ''} and share that: its link shows its own title and picture wherever it is pasted.`,
        label: 'Save as my song and share',
        action: 'save-new-share',
      };
    } else if (s.edited) {
      out.warning = warn("Your changes to the code can't go in a link until they are saved.", { label: 'Save as my song', action: 'save-new' }, { label: 'Share without my changes', action: 'dismiss' });
    }
    if (s.audience === 'admin') {
      out.recipient = 'Only you can play this beat, so a link to it would not work for anyone else. Open it to members in the Admin sheet first, or share your own copy.';
      return out;
    }
    const lead = s.accounts ? 'Or share the beat itself' : 'This link';
    out.link = { text: s.link, note: `${lead}${s.edited ? ', without your changes' : ''}: it opens the beat's page with your knob and switch positions, channel levels and tempo.` };
    out.recipient = s.audience === 'members' ? 'People need to sign in, free, to play this beat.' : 'Anyone can play the beat, no account needed.';
    return out;
  }

  if (s.kind === 'theirs') {
    if (s.edited) out.warning = warn("This link plays their song, without your changes.", { label: 'Save as my song and share', action: 'save-new-share' }, { label: 'Share their song', action: 'dismiss' });
    out.link = { text: s.link, note: `This is ${s.ownerName || 'someone else'}'s song: the link stops working if they switch sharing off.` };
    return out;
  }

  // a song that has left My songs (deleted, or signed out of) but is still on a deck
  out.warning = { text: 'This song is no longer in My songs. Keep it first, then it can be shared.', primary: { label: 'Save as my song', action: 'save-new' }, secondary: null };
  return out;
}
