if (isset($_POST['action']) && $_POST['action'] === 'eval') {
ob_end_clean();
header('Content-Type: application/json');
$timeout = (int)($_POST['timeout'] ?? 30);
set_time_limit($timeout > 0 ? $timeout : 30);
error_reporting(E_ALL);
ini_set('display_errors', '0');
ini_set('log_errors', '0');
$code = $_POST['code'] ?? '';
$error = null;
set_error_handler(function ($severity, $msg, $file, $line) use (&$error) {
$types = [E_WARNING=>'Warning',E_NOTICE=>'Notice',E_DEPRECATED=>'Deprecated',E_STRICT=>'Strict',E_USER_WARNING=>'Warning',E_USER_NOTICE=>'Notice',E_USER_ERROR=>'Error'];
$error = ($types[$severity] ?? 'Error') . ": $msg (line $line)";
});
register_shutdown_function(function () use ($timeout) {
$e = error_get_last();
if ($e && in_array($e['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR])) {
while (ob_get_level()) ob_end_clean();
if (!headers_sent()) header('Content-Type: application/json');
$msg = $e['message'] . ' (line ' . $e['line'] . ')';
if (stripos($e['message'], 'Maximum execution time') !== false) {
$msg = "Execution timed out after {$timeout}s";
}
echo json_encode(['output' => '', 'error' => $msg]);
}
});
ob_start();
try {
eval($code);
} catch (Throwable $e) {
$error = get_class($e) . ': ' . $e->getMessage() . ' (line ' . $e->getLine() . ')';
}
$out = ob_get_clean();
restore_error_handler();
echo json_encode(['output' => $out, 'error' => $error]);
exit;
}
