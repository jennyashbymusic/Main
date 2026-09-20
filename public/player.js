// A small "Now playing" box that plays a YouTube song without leaving the site. It lives OUTSIDE the part of the page that
// redraws itself (the ballot refreshes every 20 seconds and after every vote), so the song keeps playing while people vote.
import { el } from '/app.js';

export function createPlayer(host, { onChange = () => {} } = {}) {
  let current = null;
  const title = el('div', { class: 'mp-title' });
  const frame = el('div', { class: 'mp-frame' });
  const close = el('button', { class: 'mp-close', type: 'button', 'aria-label': 'Close player' }, '✕');
  const alt = el('a', { class: 'mp-alt', target: '_blank', rel: 'noopener' }, 'Not playing? Open on YouTube ↗');
  host.replaceChildren(
    frame,
    el('div', { class: 'mp-bar' }, el('div', { class: 'mp-info' }, el('span', { class: 'mp-eyebrow' }, 'Now playing'), title), close),
    alt);

  // keep the last cards from hiding behind the box
  const pad = () => { document.body.style.paddingBottom = current ? host.offsetHeight + 20 + 'px' : ''; };
  window.addEventListener('resize', pad);

  function play(song) {
    if (current && current.id === song.id) return; // already playing this one
    current = song;
    title.textContent = song.name;
    alt.href = song.url;
    // youtube-nocookie: no tracking cookies until someone presses play. autoplay is allowed because they just tapped Play.
    frame.replaceChildren(el('iframe', {
      src: 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(song.id) + '?autoplay=1&rel=0&playsinline=1',
      title: 'Jenny Ashby: ' + song.name,
      allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen',
      allowfullscreen: true,
      referrerpolicy: 'strict-origin-when-cross-origin',
    }));
    host.hidden = false;
    pad();
    onChange(song);
  }

  function stop() {
    if (!current) return;
    current = null;
    frame.replaceChildren(); // removing the frame is what stops the sound
    host.hidden = true;
    pad();
    onChange(null);
  }

  close.addEventListener('click', stop);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') stop(); });
  return { play, stop, current: () => current };
}
