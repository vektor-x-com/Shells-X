<?php
if (!function_exists('shells_x_realpath')) {
    require_once __DIR__ . '/helpers.php';
}
if (isset($_GET['download'])) {
    $file = $_GET['download'];
    if (!is_string($file) || $file === '') {
        http_response_code(400);
        exit;
    }
    $realResult = shells_x_validate_readable_file($file);
    if (isset($realResult['error'])) {
        http_response_code(404);
        exit;
    }
    $real = $realResult['path'];
    // Access control is the auth gate (password + session); downloads are
    // not additionally confined to the shell's directory — the file browser
    // navigates the whole filesystem and any browsed file must be fetchable.
    header('Content-Description: File Transfer');
    header('Content-Type: application/octet-stream');
    header('Content-Disposition: attachment; filename="' . str_replace(['"', "\r", "\n"], '', basename($real)) . '"');
    header('Expires: 0');
    header('Cache-Control: must-revalidate');
    header('Pragma: public');
    header('Content-Length: ' . filesize($real));
    readfile($real);
    exit;
}
