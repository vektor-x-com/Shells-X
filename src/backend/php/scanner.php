if (isset($_POST['action']) && strncmp($_POST['action'], 'scan_', 5) === 0) {
ob_end_clean();
header('Content-Type: application/json');
@set_time_limit(0);
ignore_user_abort(true);

// ---- Paths + GC ----
$__sc_dir = sys_get_temp_dir();
$__sc_prefix = $__sc_dir . '/shellscan_';
foreach (@glob($__sc_prefix . '*.json') ?: [] as $__f) {
if (@filemtime($__f) < time() - 86400) {
@unlink($__f);
@unlink(substr($__f, 0, -5) . '.jsonl');
@unlink(substr($__f, 0, -5) . '.lock');
}
}

// ---- Helpers ----
$__sc_state_path = function($id) use ($__sc_prefix) { return $__sc_prefix . $id . '.json'; };
$__sc_events_path = function($id) use ($__sc_prefix) { return $__sc_prefix . $id . '.jsonl'; };
$__sc_lock_path = function($id) use ($__sc_prefix) { return $__sc_prefix . $id . '.lock'; };

// Acquire LOCK_EX on the sidecar lock file. The state json itself is replaced
// atomically via rename, so locking it directly wouldn't survive the rename —
// the lock has to live on a separate, stable file.
$__sc_acquire_lock = function($id) use ($__sc_lock_path) {
$fp = @fopen($__sc_lock_path($id), 'c');
if (!$fp) return null;
if (!@flock($fp, LOCK_EX)) { @fclose($fp); return null; }
return $fp;
};
$__sc_release_lock = function($fp) {
if (!$fp) return;
@flock($fp, LOCK_UN);
@fclose($fp);
};

$__sc_read_state = function($id) use ($__sc_state_path) {
$p = $__sc_state_path($id);
if (!@is_file($p)) return null;
$raw = @file_get_contents($p);
if (!$raw) return null;
$s = @json_decode($raw, true);
return is_array($s) ? $s : null;
};

$__sc_write_state = function($id, $state) use ($__sc_state_path) {
$p = $__sc_state_path($id);
$tmp = $p . '.tmp.' . bin2hex(random_bytes(3));
@file_put_contents($tmp, json_encode($state));
@rename($tmp, $p);
};

$__sc_validate_id = function($id) {
return is_string($id) && preg_match('/^[a-f0-9]{8,16}$/', $id);
};

// CIDR + host list parser. Accepts comma-separated mix of CIDR (a.b.c.d/N), single IPs, "a.b.c.d-e" ranges.
$__sc_expand_targets = function($str) {
$ips = [];
foreach (preg_split('/[\s,]+/', trim($str)) as $part) {
if ($part === '') continue;
if (strpos($part, '/') !== false) {
list($base, $prefix) = explode('/', $part, 2);
$baseInt = ip2long($base);
$prefix = (int)$prefix;
if ($baseInt === false || $prefix < 0 || $prefix > 32) continue;
$mask = $prefix === 0 ? 0 : (~0 << (32 - $prefix));
$network = $baseInt & $mask;
$count = 1 << (32 - $prefix);
if ($count === 1) { $ips[] = long2ip($network); }
elseif ($count === 2) { $ips[] = long2ip($network); $ips[] = long2ip($network + 1); }
else { for ($i = 1; $i < $count - 1; $i++) $ips[] = long2ip($network + $i); }
} elseif (preg_match('/^(\d+\.\d+\.\d+\.)(\d+)-(\d+)$/', $part, $m)) {
$from = max(0, min(255, (int)$m[2]));
$to = max(0, min(255, (int)$m[3]));
if ($to < $from) { $t = $from; $from = $to; $to = $t; }
for ($i = $from; $i <= $to; $i++) $ips[] = $m[1] . $i;
} else {
// Plain host or IP. Resolve hostname lazily — keep as string.
$ips[] = $part;
}
}
return array_values(array_unique($ips));
};

$__sc_expand_ports = function($str) {
$ports = [];
foreach (explode(',', $str) as $part) {
$part = trim($part);
if ($part === '') continue;
if (strpos($part, '-') !== false) {
list($f, $t) = explode('-', $part, 2);
$f = max(1, (int)$f); $t = min(65535, (int)$t);
for ($p = $f; $p <= $t; $p++) $ports[] = $p;
} else {
$p = (int)$part;
if ($p >= 1 && $p <= 65535) $ports[] = $p;
}
}
return array_values(array_unique($ports));
};

// Task at integer cursor maps to (ip_idx, port_idx, proto_idx). Port-major order:
// iterate all IPs for port[0], then all IPs for port[1], etc. Faster early discovery.
$__sc_task_at = function($i, $ips, $ports, $protos) {
$nI = count($ips); $nProto = count($protos);
$proto_idx = $i % $nProto;
$ip_idx = (intdiv($i, $nProto)) % $nI;
$port_idx = intdiv($i, $nProto * $nI);
return [$ips[$ip_idx], $ports[$port_idx], $protos[$proto_idx]];
};

// ---- TCP parallel connect ----
$__sc_tcp_batch = function($tasks, $timeout_ms) {
$results = [];
$sockets = [];
$start = [];
$now = microtime(true);
foreach ($tasks as $k => $t) {
$errno = 0; $errstr = '';
$s = @stream_socket_client(
"tcp://{$t[0]}:{$t[1]}",
$errno, $errstr,
0.001,
STREAM_CLIENT_ASYNC_CONNECT | STREAM_CLIENT_CONNECT
);
if ($s) {
@stream_set_blocking($s, false);
$sockets[$k] = $s;
$start[$k] = $now;
} else {
$results[$k] = ['state' => 'closed', 'latency_ms' => 0, 'error' => $errstr ?: ('errno ' . $errno)];
}
}
$deadline = $now + ($timeout_ms / 1000);
while (!empty($sockets) && microtime(true) < $deadline) {
$r = []; $e = []; $w = $sockets;
$remain = $deadline - microtime(true);
if ($remain <= 0) break;
$tv_sec = (int)$remain;
$tv_usec = (int)(($remain - $tv_sec) * 1000000);
if (@stream_select($r, $w, $e, $tv_sec, min(200000, $tv_usec)) > 0) {
foreach ($w as $k => $sock) {
$peer = @stream_socket_get_name($sock, true);
$lat = (int)((microtime(true) - $start[$k]) * 1000);
if ($peer !== false && $peer !== '') {
$results[$k] = ['state' => 'open', 'latency_ms' => $lat, '_sock' => $sock];
} else {
$results[$k] = ['state' => 'closed', 'latency_ms' => $lat];
@fclose($sock);
}
unset($sockets[$k]);
}
} else {
// no activity this tick — loop checks deadline
}
}
foreach ($sockets as $k => $s) {
$results[$k] = ['state' => 'filtered', 'latency_ms' => $timeout_ms];
@fclose($s);
}
return $results;
};

// ---- TCP banner grab + fingerprint (subset of deleted fingerprint.php, kept inline) ----
$__sc_tcp_fingerprint = function($sock, $host, $port, $timeout_ms) {
$passive = [21, 22, 23, 25, 110, 143, 587, 3306, 5672, 11211];
$portProbe = [80=>'http',8080=>'http',8000=>'http',8888=>'http',9090=>'http',8181=>'http',
443=>'http',8443=>'http',6379=>'redis',5432=>'pgsql',27017=>'mongo',11211=>'memcache',9200=>'http'];
$probes = [
'http' => "HEAD / HTTP/1.0\r\nHost: {$host}\r\nUser-Agent: Mozilla/5.0\r\nConnection: close\r\n\r\n",
'redis' => "PING\r\nINFO server\r\nQUIT\r\n",
'pgsql' => "\x00\x00\x00\x08\x04\xd2\x16\x2f",
'memcache' => "stats\r\nquit\r\n",
];
@stream_set_blocking($sock, true);
@stream_set_timeout($sock, 0, $timeout_ms * 1000);
$banner = '';
$probe = $portProbe[$port] ?? null;
if (in_array($port, $passive) && $probe === null) {
$banner = @fread($sock, 4096) ?: '';
} elseif ($probe && isset($probes[$probe])) {
@fwrite($sock, $probes[$probe]);
$banner = '';
$end = microtime(true) + ($timeout_ms / 1000);
while (microtime(true) < $end && strlen($banner) < 8192) {
$chunk = @fread($sock, 4096);
if ($chunk === false || $chunk === '') {
$m = @stream_get_meta_data($sock);
if (!empty($m['timed_out']) || !empty($m['eof'])) break;
break;
}
$banner .= $chunk;
}
} else {
@stream_set_timeout($sock, 0, min(800000, $timeout_ms * 1000));
$banner = @fread($sock, 4096) ?: '';
if (strlen(trim($banner)) === 0) {
@fwrite($sock, $probes['http']);
@stream_set_timeout($sock, 0, $timeout_ms * 1000);
$banner = '';
$end = microtime(true) + ($timeout_ms / 1000);
while (microtime(true) < $end && strlen($banner) < 4096) {
$chunk = @fread($sock, 2048);
if ($chunk === false || $chunk === '') break;
$banner .= $chunk;
}
}
}
@fclose($sock);
$banner = substr($banner, 0, 2048);

$service = ''; $version = ''; $info = [];
if (preg_match('/^SSH-[\d.]+-(.+)/m', $banner, $m)) {
$service = 'SSH'; $version = trim($m[1]);
if (preg_match('/(Ubuntu|Debian|FreeBSD|RHEL|RedHat)/i', $m[1], $o)) $info[] = 'OS: ' . $o[1];
} elseif ($port == 21 && preg_match('/^220[- ](.+)/m', $banner, $m)) {
$service = 'FTP'; $version = trim($m[1]);
} elseif (in_array($port, [25, 465, 587]) && preg_match('/^220[- ](.+)/m', $banner, $m)) {
$service = 'SMTP'; $version = trim($m[1]);
} elseif ($port == 110 && preg_match('/^\+OK\s*(.*)/m', $banner, $m)) {
$service = 'POP3'; $version = trim($m[1]);
} elseif ($port == 143 && preg_match('/^\* OK\s*(.*)/m', $banner, $m)) {
$service = 'IMAP'; $version = trim($m[1]);
} elseif ($port == 3306 && strlen($banner) > 5) {
$service = 'MySQL';
$verEnd = strpos($banner, "\x00", 5);
if ($verEnd !== false) {
$ver = substr($banner, 5, $verEnd - 5);
if (preg_match('/[\d.]+/', $ver, $vm)) {
$version = $vm[0];
if (stripos($ver, 'MariaDB') !== false) $service = 'MariaDB';
}
}
} elseif (preg_match('/\+PONG|redis_version/m', $banner)) {
$service = 'Redis';
if (preg_match('/redis_version:([\d.]+)/m', $banner, $v)) $version = $v[1];
} elseif ($port == 5432 && strlen($banner) >= 1) {
$service = 'PostgreSQL'; $version = ($banner[0] === 'S') ? 'SSL supported' : 'No SSL';
} elseif (preg_match('/STAT version\s+([\d.]+)/m', $banner, $m)) {
$service = 'Memcached'; $version = $m[1];
} elseif ($port == 23) {
$service = 'Telnet';
$printable = preg_replace('/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\xff]/', '', $banner);
$version = trim(substr($printable, 0, 80));
}
if (preg_match('/^HTTP\/[\d.]+\s+(\d+)/m', $banner, $hm)) {
if (!$service) $service = 'HTTP';
$info[] = 'Status: ' . $hm[1];
if (preg_match('/^Server:\s*(.+)/mi', $banner, $sv)) $version = trim($sv[1]);
if (preg_match('/^X-Powered-By:\s*(.+)/mi', $banner, $xp)) $info[] = 'Powered: ' . trim($xp[1]);
if (preg_match('/^Set-Cookie:\s*(\S+)/mi', $banner, $ck)) {
$c = $ck[1];
if (stripos($c, 'PHPSESSID') !== false) $info[] = 'Framework: PHP';
elseif (stripos($c, 'JSESSIONID') !== false) $info[] = 'Framework: Java';
elseif (stripos($c, 'ASP.NET') !== false) $info[] = 'Framework: ASP.NET';
elseif (stripos($c, 'connect.sid') !== false) $info[] = 'Framework: Node';
elseif (stripos($c, 'laravel_session') !== false) $info[] = 'Framework: Laravel';
elseif (stripos($c, 'csrftoken') !== false) $info[] = 'Framework: Django';
}
}
$bannerClean = preg_replace('/[^\x20-\x7E\r\n\t]/', '.', $banner);
$bannerClean = substr(trim($bannerClean), 0, 1024);
return ['banner' => $bannerClean, 'service' => $service, 'version' => $version, 'info' => $info];
};

// TLS cert grab for 443/8443
$__sc_tls_cert = function($host, $port, $timeout_ms) {
if (!function_exists('stream_socket_client')) return null;
$ctx = stream_context_create(['ssl' => [
'capture_peer_cert' => true, 'verify_peer' => false,
'verify_peer_name' => false, 'allow_self_signed' => true,
'SNI_enabled' => true, 'peer_name' => $host,
]]);
$fp = @stream_socket_client("ssl://{$host}:{$port}", $errno, $errstr, $timeout_ms / 1000, STREAM_CLIENT_CONNECT, $ctx);
if (!$fp) return null;
$params = @stream_context_get_params($fp);
@fclose($fp);
if (empty($params['options']['ssl']['peer_certificate'])) return null;
$cert = @openssl_x509_parse($params['options']['ssl']['peer_certificate']);
if (!$cert) return null;
$sans = [];
if (!empty($cert['extensions']['subjectAltName'])) {
preg_match_all('/DNS:([^,\s]+)/', $cert['extensions']['subjectAltName'], $m);
$sans = $m[1] ?? [];
}
return [
'subject_cn' => $cert['subject']['CN'] ?? '',
'issuer_cn' => $cert['issuer']['CN'] ?? '',
'issuer_org' => $cert['issuer']['O'] ?? '',
'valid_from' => date('Y-m-d', $cert['validFrom_time_t'] ?? 0),
'valid_to' => date('Y-m-d', $cert['validTo_time_t'] ?? 0),
'self_signed' => ($cert['subject'] == $cert['issuer']),
'sans' => $sans,
];
};

// ---- UDP probe (sequential) ----
$__sc_udp_probes = [
53  => "\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x07version\x04bind\x00\x00\x10\x00\x03",
123 => "\xe3" . str_repeat("\x00", 47),
137 => "\x82\x28\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00\x20CKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\x00\x00\x21\x00\x01",
161 => "\x30\x29\x02\x01\x00\x04\x06public\xa0\x1c\x02\x04\x71\x47\x00\x00\x02\x01\x00\x02\x01\x00\x30\x0e\x30\x0c\x06\x08\x2b\x06\x01\x02\x01\x01\x01\x00\x05\x00",
500 => "\x00\x11\x22\x33\x44\x55\x66\x77\x00\x00\x00\x00\x00\x00\x00\x00\x01\x10\x02\x00\x00\x00\x00\x00\x00\x00\x00\x9c",
1900 => "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 1\r\nST: ssdp:all\r\n\r\n",
5353 => "\x00\x00\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x09_services\x07_dns-sd\x04_udp\x05local\x00\x00\x0c\x00\x01",
];

// Helper: classify a UDP service by known well-known port.
$__sc_udp_service = function($port) {
if ($port == 53) return 'DNS';
if ($port == 123) return 'NTP';
if ($port == 137) return 'NetBIOS';
if ($port == 161) return 'SNMP';
if ($port == 500) return 'IKE/IPsec';
if ($port == 1900) return 'SSDP';
if ($port == 5353) return 'mDNS';
return '';
};

// Parallel UDP scan, mirroring __sc_tcp_batch. Opens one connected UDP socket
// per task, sends the per-port probe, then drives all sockets with a single
// stream_select deadline loop. Empirically verified lossless: see
// claudedocs/research_php_parallel_udp.md. Throughput ~111x the sequential
// per-task version at concurrency=64.
$__sc_udp_batch = function($tasks, $timeout_ms) use ($__sc_udp_probes, $__sc_udp_service) {
$results = [];
$sockets = [];
$starts = [];
$now = microtime(true);
foreach ($tasks as $k => $t) {
list($host, $port) = $t;
$probe = $__sc_udp_probes[$port] ?? "\x00";
$errno = 0; $errstr = '';
// Tiny connect timeout — UDP "connect" is just kernel bookkeeping, no
// network round-trip. Failure here means resolver / route problem.
$s = @stream_socket_client("udp://{$host}:{$port}", $errno, $errstr, 0.01);
if (!$s) {
$results[$k] = ['state' => 'filtered', 'latency_ms' => 0, 'error' => $errstr ?: ('errno ' . $errno)];
continue;
}
@stream_set_blocking($s, false);
@stream_socket_sendto($s, $probe);
$sockets[$k] = $s;
$starts[$k] = $now;
}
$deadline = $now + ($timeout_ms / 1000);
while (!empty($sockets) && microtime(true) < $deadline) {
$r = $sockets; $w = []; $e = [];
$remain = $deadline - microtime(true);
if ($remain <= 0) break;
$tv_sec = (int)$remain;
$tv_usec = (int)(($remain - $tv_sec) * 1000000);
if (@stream_select($r, $w, $e, $tv_sec, min(200000, $tv_usec)) > 0) {
foreach ($r as $k => $sock) {
$peer = '';
$resp = @stream_socket_recvfrom($sock, 8192, 0, $peer);
$lat = (int)((microtime(true) - $starts[$k]) * 1000);
if ($resp !== false && $resp !== '' && strlen($resp) > 0) {
list($host, $port) = $tasks[$k];
$banner = preg_replace('/[^\x20-\x7E\r\n\t]/', '.', substr($resp, 0, 512));
$results[$k] = [
'state' => 'open',
'latency_ms' => $lat,
'banner' => trim($banner),
'service' => $__sc_udp_service($port),
'version' => '',
'info' => [],
];
} else {
// Socket reported readable but recvfrom returned nothing — usually
// ICMP Port Unreachable surfaced as ECONNREFUSED on this socket.
// Treat as filtered (we don't distinguish closed UDP separately).
$results[$k] = ['state' => 'filtered', 'latency_ms' => $lat];
}
@fclose($sock);
unset($sockets[$k]);
}
}
}
// Anything left at deadline didn't reply — filtered.
foreach ($sockets as $k => $s) {
$results[$k] = ['state' => 'filtered', 'latency_ms' => $timeout_ms];
@fclose($s);
}
return $results;
};

// =================== ACTION DISPATCH ===================
$action = $_POST['action'];

if ($action === 'scan_start') {
$targetsStr = trim($_POST['targets'] ?? '');
$portsStr = trim($_POST['ports'] ?? '');

// Reject absurd CIDR prefixes up front. /7 = 33M IPs, /0 = 4B IPs — both will
// either OOM the PHP process or hang the request in expand_targets.
foreach (preg_split('/[\s,]+/', $targetsStr) as $__t) {
if (strpos($__t, '/') !== false) {
$__p = (int)substr($__t, strpos($__t, '/') + 1);
if ($__p < 8 || $__p > 32) {
echo json_encode(['error' => "CIDR prefix out of range in '$__t' (must be /8..32)"]);
exit;
}
}
}

$proto = $_POST['proto'] ?? 'tcp';
$timeout_ms = max(50, min(10000, (int)($_POST['timeout_ms'] ?? 800)));
$concurrency = max(1, min(512, (int)($_POST['concurrency'] ?? 64)));
$batch_ms = max(200, min(10000, (int)($_POST['batch_ms'] ?? 1500)));
$fingerprint = !empty($_POST['fingerprint']);

if (!in_array($proto, ['tcp', 'udp', 'both'])) $proto = 'tcp';
$protos = $proto === 'both' ? ['tcp', 'udp'] : [$proto];

$ips = $__sc_expand_targets($targetsStr);
$ports = $__sc_expand_ports($portsStr);

if (empty($ips)) { echo json_encode(['error' => 'No valid targets']); exit; }
if (empty($ports)) { echo json_encode(['error' => 'No valid ports']); exit; }

$total = count($ips) * count($ports) * count($protos);

$id = bin2hex(random_bytes(4));
$state = [
'id' => $id,
'status' => 'running',
'started_at' => time(),
'finished_at' => null,
'opts' => [
'targets_str' => $targetsStr,
'ports_str' => $portsStr,
'proto' => $proto,
'timeout_ms' => $timeout_ms,
'concurrency' => $concurrency,
'batch_ms' => $batch_ms,
'fingerprint' => $fingerprint,
],
'ips' => $ips,
'ports' => $ports,
'protos' => $protos,
'total' => $total,
'cursor' => 0,
'seq' => 0,
'summary' => ['open' => 0, 'closed' => 0, 'filtered' => 0],
];
$__sc_write_state($id, $state);
@file_put_contents($__sc_events_path($id), '');
echo json_encode(['id' => $id, 'total' => $total, 'host_count' => count($ips), 'port_count' => count($ports)]);
exit;
}

if ($action === 'scan_poll') {
$id = $_POST['id'] ?? '';
$since = max(0, (int)($_POST['since'] ?? 0));
if (!$__sc_validate_id($id)) { echo json_encode(['error' => 'Invalid id']); exit; }

// Serialize all state mutation for this scan id across concurrent requests
// (multi-tab pollers, control actions, reattach race). Held through the full
// batch; pause/resume/stop will queue until the current batch finishes.
$lockFp = $__sc_acquire_lock($id);
$state = $__sc_read_state($id);
if (!$state) { $__sc_release_lock($lockFp); echo json_encode(['error' => 'Scan not found']); exit; }

if ($state['status'] === 'running' && $state['cursor'] < $state['total']) {
$batchStart = microtime(true);
$batchDeadline = $batchStart + ($state['opts']['batch_ms'] / 1000);
$ips = $state['ips']; $ports = $state['ports']; $protos = $state['protos'];

while (microtime(true) < $batchDeadline && $state['cursor'] < $state['total']) {
$batchSize = min($state['opts']['concurrency'], $state['total'] - $state['cursor']);
$tcpTasks = []; $udpTasks = []; $taskOrder = [];
for ($i = 0; $i < $batchSize; $i++) {
$idx = $state['cursor'] + $i;
list($host, $port, $pr) = $__sc_task_at($idx, $ips, $ports, $protos);
$key = $idx;
$taskOrder[$key] = ['host' => $host, 'port' => $port, 'proto' => $pr];
if ($pr === 'tcp') $tcpTasks[$key] = [$host, $port];
else $udpTasks[$key] = [$host, $port];
}

$batchResults = [];
if (!empty($tcpTasks)) {
$tcpResults = $__sc_tcp_batch($tcpTasks, $state['opts']['timeout_ms']);
foreach ($tcpResults as $k => $r) {
if ($r['state'] === 'open' && $state['opts']['fingerprint'] && isset($r['_sock'])) {
$ti = $taskOrder[$k];
$fp = $__sc_tcp_fingerprint($r['_sock'], $ti['host'], $ti['port'], $state['opts']['timeout_ms']);
$r = array_merge($r, $fp);
if (in_array($ti['port'], [443, 8443])) {
$tls = $__sc_tls_cert($ti['host'], $ti['port'], $state['opts']['timeout_ms']);
if ($tls) $r['tls'] = $tls;
}
} elseif (isset($r['_sock'])) {
@fclose($r['_sock']);
}
unset($r['_sock']);
$batchResults[$k] = $r;
}
}
if (!empty($udpTasks)) {
$udpResults = $__sc_udp_batch($udpTasks, $state['opts']['timeout_ms']);
foreach ($udpResults as $k => $r) $batchResults[$k] = $r;
}

// Only 'open' events get persisted to jsonl. closed/filtered just bump
// summary counters in state, keeping the events file tiny on huge scans.
$evFp = null;
foreach ($batchResults as $k => $r) {
$ti = $taskOrder[$k];
$sumKey = $r['state'];
if (!isset($state['summary'][$sumKey])) $state['summary'][$sumKey] = 0;
$state['summary'][$sumKey]++;
if ($r['state'] !== 'open') continue;
$ev = [
'seq' => $state['seq']++,
'ts' => time(),
'host' => $ti['host'],
'port' => $ti['port'],
'proto' => $ti['proto'],
'state' => $r['state'],
'latency_ms' => $r['latency_ms'] ?? 0,
];
if (!empty($r['banner'])) $ev['banner'] = $r['banner'];
if (!empty($r['service'])) $ev['service'] = $r['service'];
if (!empty($r['version'])) $ev['version'] = $r['version'];
if (!empty($r['info'])) $ev['info'] = $r['info'];
if (!empty($r['tls'])) $ev['tls'] = $r['tls'];
if ($evFp === null) $evFp = @fopen($__sc_events_path($id), 'a');
if ($evFp) fwrite($evFp, json_encode($ev) . "\n");
}
if ($evFp) fclose($evFp);
$state['cursor'] += $batchSize;
$__sc_write_state($id, $state);
}

if ($state['cursor'] >= $state['total'] && $state['status'] === 'running') {
$state['status'] = 'done';
$state['finished_at'] = time();
$__sc_write_state($id, $state);
}
}
$__sc_release_lock($lockFp);

// Read events since offset
$events = [];
$next_offset = $since;
$evPath = $__sc_events_path($id);
if (@is_file($evPath)) {
$size = @filesize($evPath) ?: 0;
if ($size > $since) {
$fp = @fopen($evPath, 'r');
if ($fp) {
@fseek($fp, $since);
$buf = @stream_get_contents($fp);
$next_offset = @ftell($fp);
@fclose($fp);
foreach (explode("\n", $buf) as $line) {
$line = trim($line);
if ($line === '') continue;
$obj = @json_decode($line, true);
if ($obj) $events[] = $obj;
}
}
}
}

echo json_encode([
'state' => [
'id' => $state['id'],
'status' => $state['status'],
'started_at' => $state['started_at'],
'finished_at' => $state['finished_at'],
'total' => $state['total'],
'cursor' => $state['cursor'],
'summary' => $state['summary'],
'opts' => $state['opts'],
],
'events' => $events,
'next_offset' => $next_offset,
]);
exit;
}

if ($action === 'scan_pause' || $action === 'scan_resume' || $action === 'scan_stop') {
$id = $_POST['id'] ?? '';
if (!$__sc_validate_id($id)) { echo json_encode(['error' => 'Invalid id']); exit; }
// Block until any in-flight poll batch finishes so the status change isn't
// overwritten by the poll's post-batch state write.
$lockFp = $__sc_acquire_lock($id);
$state = $__sc_read_state($id);
if (!$state) { $__sc_release_lock($lockFp); echo json_encode(['error' => 'Scan not found']); exit; }
if ($action === 'scan_pause' && $state['status'] === 'running') $state['status'] = 'paused';
elseif ($action === 'scan_resume' && $state['status'] === 'paused') $state['status'] = 'running';
elseif ($action === 'scan_stop' && in_array($state['status'], ['running', 'paused'])) {
$state['status'] = 'stopped';
$state['finished_at'] = time();
}
$__sc_write_state($id, $state);
$__sc_release_lock($lockFp);
echo json_encode(['status' => $state['status']]);
exit;
}

if ($action === 'scan_list') {
$out = [];
foreach (@glob($__sc_prefix . '*.json') ?: [] as $f) {
$s = @json_decode(@file_get_contents($f), true);
if (!$s || !isset($s['id'])) continue;
$out[] = [
'id' => $s['id'],
'status' => $s['status'],
'started_at' => $s['started_at'],
'finished_at' => $s['finished_at'] ?? null,
'total' => $s['total'],
'cursor' => $s['cursor'],
'opts' => $s['opts'],
'summary' => $s['summary'],
];
}
usort($out, function($a, $b) { return $b['started_at'] - $a['started_at']; });
echo json_encode(['scans' => $out]);
exit;
}

if ($action === 'scan_destroy') {
$id = $_POST['id'] ?? '';
if (!$__sc_validate_id($id)) { echo json_encode(['error' => 'Invalid id']); exit; }
@unlink($__sc_state_path($id));
@unlink($__sc_events_path($id));
@unlink($__sc_lock_path($id));
echo json_encode(['ok' => true]);
exit;
}

echo json_encode(['error' => 'Unknown scan action: ' . $action]);
exit;
}
