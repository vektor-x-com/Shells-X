// Crypto module — AES-256-CBC transport matching PHP openssl (crypto.php).
// Always uses vendored sha256 + aesjs so behaviour is identical on HTTPS,
// http://192.168.x.x, and localhost (Web Crypto subtle is intentionally unused).
try {
(function() {
  if (typeof __BUILD === 'undefined' || !__BUILD.encrypted) return;

  if (typeof sha256 !== 'function' || typeof aesjs === 'undefined') {
    throw new Error('crypto.js requires sha256.js and aesjs.js before crypto.js');
  }

  function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    return bytes;
  }

  function bytesToB64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function b64ToBytes(b64) {
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  }

  function arrayBufferToB64(buf) {
    return bytesToB64(new Uint8Array(buf));
  }

  // IVs must come from a CSPRNG. getRandomValues is available in all browsers we
  // target (incl. HTTP LAN IPs); it is not gated on secure context (unlike
  // crypto.subtle). Missing only on obsolete engines (IE9-), locked-down
  // WebViews, or rare hardening that disables Web Crypto entirely.
  function randomBytes(n) {
    if (!window.crypto || typeof window.crypto.getRandomValues !== 'function') {
      throw new Error(
        'crypto.getRandomValues() is not available — use a current browser; ' +
        'encryption cannot run safely without it.'
      );
    }
    const out = new Uint8Array(n);
    window.crypto.getRandomValues(out);
    return out;
  }

  function digestSha256Hex(str) {
    return sha256(str);
  }

  // Wire format: base64( iv[16] || aes-256-cbc-pkcs7(plaintext) ) — same as PHP side.
  function encryptStr(plaintext, keyHex) {
    const key = Array.from(hexToBytes(keyHex));
    const iv = Array.from(randomBytes(16));
    const padded = aesjs.padding.pkcs7.pad(Array.from(new TextEncoder().encode(plaintext)));
    const enc = new aesjs.ModeOfOperation.cbc(key, iv).encrypt(padded);
    const out = new Uint8Array(16 + enc.length);
    out.set(iv);
    out.set(enc, 16);
    return bytesToB64(out);
  }

  function unwrapEncBody(text) {
    let t = text.trim();
    const m = t.match(/^<!--\s*([\s\S]*?)\s*-->$/);
    if (m) t = m[1].trim();
    return t;
  }

  function decryptStr(b64, keyHex) {
    const key = Array.from(hexToBytes(keyHex));
    const raw = b64ToBytes(b64);
    const iv = Array.from(raw.slice(0, 16));
    const ct = Array.from(raw.slice(16));
    const dec = aesjs.padding.pkcs7.strip(new aesjs.ModeOfOperation.cbc(key, iv).decrypt(ct));
    return new TextDecoder().decode(new Uint8Array(dec));
  }

  async function fdToQueryString(fd) {
    const params = new URLSearchParams();
    for (const [k, v] of fd.entries()) {
      if (v instanceof File) {
        params.append('file_name', v.name);
        params.append('file_b64', arrayBufferToB64(await v.arrayBuffer()));
      } else {
        params.append(k, v);
      }
    }
    return params.toString();
  }

  function _showPassphraseOverlay(digestFn) {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:var(--bg,#1a1a1a);display:flex;align-items:center;justify-content:center;z-index:9999';
    ov.innerHTML =
      '<div style="background:var(--surface,#252525);border:1px solid var(--border,#333);border-radius:8px;padding:32px;width:320px;max-width:90vw">'
      + '<div style="font-size:14px;font-weight:600;margin-bottom:8px;color:var(--fg,#e0e0e0)">Session key required</div>'
      + '<div style="font-size:12px;color:var(--muted,#888);margin-bottom:16px">Enter the login password to initialise the encryption key for this tab.</div>'
      + '<input id="__sx_enc_pw" type="password" placeholder="Password" autocomplete="current-password"'
      +   ' style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--border,#333);border-radius:4px;background:var(--bg,#1a1a1a);color:var(--fg,#e0e0e0);font-size:13px;margin-bottom:12px">'
      + '<button id="__sx_enc_ok" style="width:100%;padding:8px;background:var(--accent,#4a9eff);color:#fff;border:none;border-radius:4px;font-size:13px;cursor:pointer">Unlock</button>'
      + '<div id="__sx_enc_err" style="color:var(--red,#f85149);font-size:12px;margin-top:8px;min-height:16px"></div>'
      + '</div>';
    document.body.appendChild(ov);
    const inp = ov.querySelector('#__sx_enc_pw');
    const btn = ov.querySelector('#__sx_enc_ok');
    const err = ov.querySelector('#__sx_enc_err');
    inp.focus();
    function submit() {
      const pw = inp.value;
      if (!pw) { err.textContent = 'Password required'; return; }
      sessionStorage.setItem('__enc_key', digestFn(pw));
      location.reload();
    }
    btn.addEventListener('click', submit);
    inp.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  }

  let encKeyHex = sessionStorage.getItem('__enc_key');
  if (!encKeyHex) {
    _showPassphraseOverlay(digestSha256Hex);
    return;
  }

  window.fetchJSON = async function(fd) {
    const params = await fdToQueryString(fd);
    const encPayload = encryptStr(params, encKeyHex);
    const encFd = new FormData();
    encFd.append('__enc', encPayload);

    const response = await fetch(BASE_URL, { method: 'POST', body: encFd });
    const encText = unwrapEncBody(await response.text());
    let plaintext = null;
    try { plaintext = decryptStr(encText, encKeyHex); }
    catch(_) { /* fall through */ }

    if (plaintext !== null) {
      try { return JSON.parse(plaintext); }
      catch(_) {
        return { output: plaintext, error: null, _raw: true };
      }
    }

    throw new Error('Response was neither encrypted nor JSON:\n' +
      encText.substring(0, 500));
  };

  window.ShellsXDigestSha256 = digestSha256Hex;
})();
} catch (e) {
  console.error('crypto module init failed:', e);
}
