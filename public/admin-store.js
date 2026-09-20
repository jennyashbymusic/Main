// The "Add music" panel in /admin > Music store: upload songs and albums from the browser, see what is in the store, remove things.
// It needs the admin login (the same one that opened /admin); every call goes to /admin/api/store/*.
import { $, api, el } from '/app.js';
import { planUploads } from '/upload-plan.js';

const host = document.getElementById('storeUpload');
if (host) init();

const mb = (bytes) => (bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(1)} GB` : `${(bytes / 1048576).toFixed(1)} MB`);
const changed = () => window.dispatchEvent(new Event('store-changed'));

async function init() {
  let info;
  try { info = await api('/admin/api/store/files'); } catch (err) { host.replaceChildren(el('p', { class: 'muted' }, err.message)); return; }
  if (info.bucket) {
    host.replaceChildren(el('p', { class: 'muted small', style: 'margin:10px 0 0' }, `Your music is kept in the Supabase bucket "${info.bucket}". Upload and remove it there (see DEPLOY.md, step 9).`));
    return;
  }

  let queue = []; // upload jobs, each { file, kind, album, name, rel, size, status, pct, error, row }
  let running = false;
  let ignoredTotal = 0; // files picked that are not music or covers

  // ---------- the panel ----------
  const songsInput = el('input', { type: 'file', multiple: true, accept: 'audio/*,image/*,.mp3,.wav,.flac,.m4a,.aac,.ogg,.aif,.aiff,.jpg,.jpeg,.png,.webp', hidden: true });
  const folderInput = el('input', { type: 'file', multiple: true, hidden: true });
  folderInput.setAttribute('webkitdirectory', '');
  const summary = el('p', { class: 'small', style: 'margin:10px 0 4px', role: 'status' });
  const list = el('div', { class: 'small', style: 'max-height:260px;overflow:auto' });
  const usage = el('p', { class: 'muted small', style: 'margin:0 0 10px' });
  const retry = el('button', { class: 'btn ghost sm', type: 'button', hidden: true }, 'Retry the ones that failed');
  const clear = el('button', { class: 'btn ghost sm', type: 'button', hidden: true }, 'Clear this list');
  const zone = el('div', { class: 'dropzone' },
    el('p', { style: 'margin:0 0 10px' }, el('b', {}, 'Drag songs or whole album folders here'), el('br'), el('span', { class: 'muted small' }, 'A loose file is a song. A folder is an album (the folder name is the album name). A cover picture goes with its song, or into the album folder.')),
    el('div', { class: 'row', style: 'justify-content:center;gap:10px' },
      el('button', { class: 'btn sm', type: 'button', onclick: () => songsInput.click() }, 'Choose songs…'),
      el('button', { class: 'btn ghost sm', type: 'button', onclick: () => folderInput.click() }, 'Choose an album folder…')),
    songsInput, folderInput);
  const manage = el('details', { style: 'margin-top:14px' });
  host.replaceChildren(el('h4', { style: 'margin:16px 0 8px' }, 'Add music'), usage, zone, summary, list, el('div', { class: 'row', style: 'gap:8px;margin-top:8px' }, retry, clear), manage);

  // ---------- what is already in the store ----------
  async function reload() {
    info = await api('/admin/api/store/files');
    usage.textContent = `The store holds ${mb(info.totalBytes)} (${info.songs.length} songs, ${info.albums.length} albums).${info.freeBytes != null ? ` ${mb(info.freeBytes)} free on the disk.` : ''} Biggest single file: ${info.maxFileMb} MB.`;
    drawManage();
  }

  function drawManage() {
    const search = el('input', { type: 'search', placeholder: 'Search your files…', 'aria-label': 'Search your files', style: 'width:100%;margin:8px 0' });
    const box = el('div', { class: 'manage-list' });
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const rows = [];
      for (const a of info.albums.filter((x) => !q || x.name.toLowerCase().includes(q))) {
        rows.push(el('div', { class: 'uprow', style: 'grid-template-columns:minmax(0,1fr) auto' },
          el('span', { class: 'name' }, el('b', {}, 'Album: '), a.name, el('span', { class: 'muted' }, ` · ${a.tracks.length} track${a.tracks.length === 1 ? '' : 's'}${a.cover ? '' : ' · no cover'}`)),
          el('button', { class: 'btn ghost sm', type: 'button', onclick: async () => {
            if (!confirm(`Remove the album "${a.name}" and all its tracks from the store?`)) return;
            await api('/admin/api/store/delete', { method: 'POST', body: { album: a.name } }); await reload(); changed();
          } }, 'Remove')));
      }
      for (const s of info.songs.filter((x) => !q || x.name.toLowerCase().includes(q))) {
        rows.push(el('div', { class: 'uprow', style: 'grid-template-columns:minmax(0,1fr) auto' },
          el('span', { class: 'name' }, s.name, el('span', { class: 'muted' }, ` · ${mb(s.size)}${s.cover ? ' · cover' : ''}`)),
          el('button', { class: 'btn ghost sm', type: 'button', onclick: async () => {
            if (!confirm(`Remove "${s.name}" from the store?`)) return;
            await api('/admin/api/store/delete', { method: 'POST', body: { files: [`songs/${s.name}`, ...(s.cover ? [`songs/${s.cover}`] : [])] } }); await reload(); changed();
          } }, 'Remove')));
      }
      box.replaceChildren(...(rows.length ? rows : [el('p', { class: 'muted', style: 'margin:8px 0' }, q ? 'Nothing matches.' : 'The store is empty. Add some music above.')]));
    };
    search.oninput = draw;
    draw();
    manage.replaceChildren(el('summary', { style: 'cursor:pointer' }, `Everything in the store (${info.songs.length} songs, ${info.albums.length} albums)`), search, box);
  }

  // ---------- queue ----------
  const ICON = { todo: 'waiting', uploading: 'uploading', done: 'done ✓', exists: 'already there', failed: 'failed', 'too-big': 'too big', empty: 'empty file' };
  function paint(job) {
    if (!job.row) {
      job.nameEl = el('span', { class: 'name', title: job.rel }, job.rel);
      job.stEl = el('span', { class: 'st' });
      job.bar = el('i', { style: 'width:0%' });
      job.row = el('div', { class: 'uprow' }, job.nameEl, el('div', { class: 'bar', role: 'presentation' }, job.bar), job.stEl);
      list.append(job.row);
    }
    job.row.className = `uprow ${job.status === 'done' ? 'ok' : job.status === 'failed' || job.status === 'too-big' || job.status === 'empty' ? 'err' : job.status === 'exists' ? 'skip' : ''}`;
    job.bar.style.width = `${job.status === 'done' || job.status === 'exists' ? 100 : Math.round((job.pct || 0) * 100)}%`;
    job.stEl.textContent = job.status === 'uploading' ? `${Math.round((job.pct || 0) * 100)}%` : ICON[job.status] || job.status;
    job.row.title = job.error || '';
  }
  function tally() {
    const c = (s) => queue.filter((j) => j.status === s).length;
    const doneN = c('done'), skipped = c('exists'), failed = c('failed') + c('too-big') + c('empty'), left = c('todo') + c('uploading');
    summary.textContent = queue.length ? `${doneN} uploaded · ${skipped} already there · ${failed} failed · ${left} to go${ignoredTotal ? ` · ${ignoredTotal} ignored (not music or covers)` : ''}` : '';
    retry.hidden = failed === 0 || running;
    clear.hidden = !queue.length || running;
  }

  function send(job) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `/admin/api/store/upload?kind=${job.kind}&album=${encodeURIComponent(job.album)}&name=${encodeURIComponent(job.name)}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) { job.pct = e.loaded / e.total; paint(job); } };
      xhr.onload = () => {
        if (xhr.status === 200) return resolve();
        let msg = `HTTP ${xhr.status}`;
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* not JSON */ }
        reject(new Error(msg));
      };
      xhr.onerror = () => reject(new Error('The connection dropped. Use "Retry the ones that failed".'));
      xhr.send(job.file);
    });
  }

  async function run() {
    if (running) return;
    running = true; tally();
    const worker = async () => {
      for (;;) {
        const job = queue.find((j) => j.status === 'todo');
        if (!job) return;
        job.status = 'uploading'; job.pct = 0; paint(job); tally();
        try { await send(job); job.status = 'done'; job.error = ''; } catch (err) { job.status = 'failed'; job.error = err.message; }
        paint(job); tally();
      }
    };
    await Promise.all([worker(), worker()]); // two at a time
    running = false; tally();
    await reload(); changed();
  }

  async function add(items) {
    if (!items.length) return;
    await reload(); // fresh list, so anything uploaded earlier (even in another tab) is skipped
    const { jobs, ignored } = planUploads(items, info.files, info.maxFileMb * 1048576);
    for (const j of jobs) {
      if (j.status === 'too-big') j.error = `Bigger than ${info.maxFileMb} MB`;
      queue.push(j); paint(j);
    }
    ignoredTotal += ignored.length;
    tally();
    run();
  }

  songsInput.onchange = () => { add([...songsInput.files].map((file) => ({ file, path: file.name }))); songsInput.value = ''; };
  folderInput.onchange = () => { add([...folderInput.files].map((file) => ({ file, path: file.webkitRelativePath || file.name }))); folderInput.value = ''; };
  retry.onclick = () => { queue.filter((j) => j.status === 'failed').forEach((j) => { j.status = 'todo'; paint(j); }); run(); };
  clear.onclick = () => { queue = []; ignoredTotal = 0; list.replaceChildren(); tally(); };

  // ---------- drag and drop (files and whole folders) ----------
  async function fromDrop(dt) {
    const out = [];
    const walk = async (entry, prefix) => {
      if (entry.isFile) {
        out.push({ file: await new Promise((res, rej) => entry.file(res, rej)), path: prefix + entry.name });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        for (let batch = await new Promise((res, rej) => reader.readEntries(res, rej)); batch.length; batch = await new Promise((res, rej) => reader.readEntries(res, rej))) {
          for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
        }
      }
    };
    // The browser only lets us read what was dropped WHILE the drop event is being handled, so grab everything now, before any
    // "await". (Reading item number 2 after waiting on item number 1 would find the list already emptied.)
    const entries = [...(dt.items || [])].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
    const plainFiles = [...(dt.files || [])];
    for (const entry of entries) await walk(entry, '');
    // A browser without the folder API (or a drop of plain files it did not describe as entries): use the file list, as loose songs
    if (!out.length) for (const file of plainFiles) out.push({ file, path: file.name });
    return out;
  }
  ['dragenter', 'dragover'].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.remove('over'); }));
  zone.addEventListener('drop', async (e) => { add(await fromDrop(e.dataTransfer)); });

  // let tests and other scripts hand files to the panel directly
  window.__storeUpload = { add, reload };
  await reload();
}
