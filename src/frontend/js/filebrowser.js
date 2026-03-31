// ==================== FILE BROWSER ====================
let currentDir = '/';

document.getElementById('files-body').addEventListener('click', ev => {
  const link = ev.target.closest('.dir-link');
  if (link) { ev.preventDefault(); browseDir(link.dataset.path); }
});

function browseDir(path) {
  currentDir = path;
  const body = document.getElementById('files-body');
  document.getElementById('files-path-input').value = path;
  body.innerHTML = '<div style="padding:16px"><span class="spinner"></span>Loading...</div>';

  const fd = new FormData();
  fd.append('action', 'ls');
  fd.append('dir', path);

  fetchJSON(fd)
    .then(data => {
      currentDir = data.dir;
      document.getElementById('files-path-input').value = data.dir;
      if (!data.entries || data.entries.length === 0) {
        body.innerHTML = '<div style="padding:16px;color:var(--muted)">Empty or unreadable.</div>';
        return;
      }
      let html = '<table class="file-table"><thead><tr><th>Name</th><th>Size</th><th>Modified</th><th>Owner</th><th>Perms</th><th>R/W</th><th></th></tr></thead><tbody>';
      data.entries.forEach(e => {
        let name = escHtml(e.name);
        let icon = e.dir ? '&#x1F4C2;' : '&#x1F4C4;';
        let nameStyle = '';
        if (e.symlink) {
          icon = '&#x1F517;';
          const target = escHtml(e.link_target || '?');
          name += ' <span style="color:var(--muted);font-size:11px">&rarr; ' + target + '</span>';
          if (e.broken) nameStyle = 'color:var(--red);text-decoration:line-through';
        }
        const size = e.dir ? '&mdash;' : (e.size !== null ? formatBytes(e.size) : '?');
        const mtime = e.mtime ? new Date(e.mtime * 1000).toISOString().replace('T', ' ').substring(0, 19) : '?';
        const ownerGroup = escHtml(e.owner) + ':' + escHtml(e.group);
        const rw = (e.readable ? '<span style="color:var(--green)">R</span>' : '<span style="color:var(--muted)">-</span>')
          + (e.writable ? '<span style="color:var(--red)">W</span>' : '<span style="color:var(--muted)">-</span>');
        if (e.dir) {
          html += '<tr><td><a class="file-dir dir-link" href="#" data-path="' + escHtml(e.path) + '" style="' + nameStyle + '">' + icon + ' ' + name + '</a></td>';
          html += '<td style="color:var(--muted);font-size:11px">' + size + '</td>';
          html += '<td style="color:var(--muted);font-size:11px">' + mtime + '</td>';
          html += '<td style="color:var(--muted);font-size:11px">' + ownerGroup + '</td>';
          html += '<td><span class="perm">' + escHtml(e.perms) + '</span></td>';
          html += '<td style="font-size:11px">' + rw + '</td>';
          html += '<td><button class="btn btn-sm btn-danger" data-path="' + escHtml(e.path) + '" onclick="deleteFile(this.dataset.path,true)">Del</button></td></tr>';
        } else {
          const dlUrl = location.pathname + '?download=' + encodeURIComponent(e.path);
          html += '<tr><td><a class="file-name" href="' + dlUrl + '" style="' + nameStyle + '">' + icon + ' ' + name + '</a></td>';
          html += '<td style="color:var(--muted);font-size:11px">' + size + '</td>';
          html += '<td style="color:var(--muted);font-size:11px">' + mtime + '</td>';
          html += '<td style="color:var(--muted);font-size:11px">' + ownerGroup + '</td>';
          html += '<td><span class="perm">' + escHtml(e.perms) + '</span></td>';
          html += '<td style="font-size:11px">' + rw + '</td>';
          html += '<td><button class="btn btn-sm btn-danger" data-path="' + escHtml(e.path) + '" onclick="deleteFile(this.dataset.path,false)">Del</button></td></tr>';
        }
      });
      html += '</tbody></table>';
      body.innerHTML = html;
    })
    .catch(err => {
      body.innerHTML = '<div style="padding:16px;color:var(--red)">Error: ' + escHtml(String(err)) + '</div>';
    });
}

function deleteFile(path, isDir) {
  const msg = isDir ? 'Delete directory ' + path + '? (must be empty)' : 'Delete ' + path + '?';
  if (!confirm(msg)) return;
  const fd = new FormData();
  fd.append('action', 'delete');
  fd.append('path', path);
  fetchJSON(fd)
    .then(data => {
      if (data.error) alert('Error: ' + data.error);
      else browseDir(currentDir);
    })
    .catch(e => alert('Request failed: ' + e.message));
}

function uploadFile() {
  const input = document.getElementById('upload-input');
  const status = document.getElementById('upload-status');
  const file = input.files[0];
  if (!file) { status.textContent = 'No file selected.'; return; }
  const fd = new FormData();
  fd.append('action', 'upload');
  fd.append('dir', currentDir);
  fd.append('file', file);
  status.style.color = 'var(--muted)';
  status.textContent = 'Uploading...';
  fetchJSON(fd)
    .then(data => {
      if (data.error) { status.style.color = 'var(--red)'; status.textContent = 'Error: ' + data.error; }
      else {
        status.style.color = 'var(--green)';
        let msg = 'Uploaded: ' + data.path + ' (' + formatBytes(data.size) + ')';
        if (data.overwritten) msg += ' [overwritten]';
        status.textContent = msg;
        input.value = '';
        browseDir(currentDir);
      }
    })
    .catch(e => { status.style.color = 'var(--red)'; status.textContent = 'Upload failed: ' + e.message; });
}
