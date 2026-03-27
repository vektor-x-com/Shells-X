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
      let html = '<table class="file-table"><thead><tr><th>Name</th><th>Owner</th><th>Permissions</th><th></th></tr></thead><tbody>';
      data.entries.forEach(e => {
        const name = escHtml(e.name);
        if (e.dir) {
          html += '<tr><td><a class="file-dir dir-link" href="#" data-path="' + escHtml(e.path) + '">&#x1F4C2; ' + name + '</a></td>';
          html += '<td style="color:var(--muted);font-size:12px">' + escHtml(e.owner) + '</td>';
          html += '<td><span class="perm">' + escHtml(e.perms) + '</span></td><td></td></tr>';
        } else {
          const dlUrl = location.pathname + '?download=' + encodeURIComponent(e.path);
          html += '<tr><td><a class="file-name" href="' + dlUrl + '">&#x1F4C4; ' + name + '</a></td>';
          html += '<td style="color:var(--muted);font-size:12px">' + escHtml(e.owner) + '</td>';
          html += '<td><span class="perm">' + escHtml(e.perms) + '</span></td>';
          html += '<td><button class="btn btn-sm btn-danger" data-path="' + escHtml(e.path) + '" onclick="deleteFile(this.dataset.path)">Del</button></td></tr>';
        }
      });
      html += '</tbody></table>';
      body.innerHTML = html;
    })
    .catch(err => {
      body.innerHTML = '<div style="padding:16px;color:var(--red)">Error: ' + escHtml(String(err)) + '</div>';
    });
}

function deleteFile(path) {
  if (!confirm('Delete ' + path + '?')) return;
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
      else { status.style.color = 'var(--green)'; status.textContent = 'Uploaded: ' + data.path; input.value = ''; browseDir(currentDir); }
    })
    .catch(e => { status.style.color = 'var(--red)'; status.textContent = 'Upload failed: ' + e.message; });
}
