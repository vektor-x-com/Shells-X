<?php
if (isset($_POST['action']) && $_POST['action'] === 'eval') {
    ob_end_clean();
    header('Content-Type: application/json');
    $timeout = (int) ($_POST['timeout'] ?? 30);
    set_time_limit($timeout > 0 ? $timeout : 30);
    error_reporting(E_ALL);
    ini_set('display_errors', '0');
    ini_set('log_errors', '0');
    $code = $_POST['code'] ?? '';
    $error = null;
    set_error_handler(function ($severity, $msg, $file, $line) use (&$error) {
        $types = [E_WARNING => 'Warning', E_NOTICE => 'Notice', E_DEPRECATED => 'Deprecated', E_STRICT => 'Strict', E_USER_WARNING => 'Warning', E_USER_NOTICE => 'Notice', E_USER_ERROR => 'Error'];
        $error = ($types[$severity] ?? 'Error') . ": $msg (line $line)";
    });
    // Baseline buffer depth BEFORE we add our eval-capture buffer. Anything at
    // or below this level is owned by the outer infrastructure (crypto.php's
    // encryption buffer when --password is on, or nothing). We must never
    // destroy those — destroying the encryption buffer sends raw bytes to the
    // client, and the frontend's crypto.js can't decrypt the response.
    $__obl_pre = ob_get_level();
    register_shutdown_function(function () use ($timeout, $__obl_pre) {
        $e = error_get_last();
        if ($e && in_array($e['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR])) {
            // Drop only buffers added since this handler started — preserve
            // the encryption buffer (and anything else upstream).
            while (ob_get_level() > $__obl_pre)
                ob_end_clean();
            if (!headers_sent())
                header('Content-Type: application/json');
            $msg = $e['message'] . ' (line ' . $e['line'] . ')';
            if (stripos($e['message'], 'Maximum execution time') !== false) {
                $msg = "Execution timed out after {$timeout}s";
            }
            echo json_encode(['output' => '', 'error' => $msg]);
        }
    });
    ob_start();
    $__obl_ours = ob_get_level();
    try {
        eval ($code);
    } catch (Throwable $e) {
        $error = get_class($e) . ': ' . $e->getMessage() . ' (line ' . $e->getLine() . ')';
    }
    // User code may have added or destroyed its own buffers. Be defensive:
    // - Pop any buffers user added ABOVE ours (collecting their content into $out).
    // - If our buffer survived, get_clean ours.
    // - Never go below $__obl_pre (the encryption buffer must survive).
    $out = '';
    while (ob_get_level() > $__obl_ours)
        $out .= ob_get_clean();
    if (ob_get_level() === $__obl_ours)
        $out = ob_get_clean() . $out;
    restore_error_handler();
    echo json_encode(['output' => $out, 'error' => $error]);
    exit;
}
