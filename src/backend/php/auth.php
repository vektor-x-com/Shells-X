<?php
// Password gate — injected via templates/php.tpl; filled at build (shellsx/auth.py).
$__AUTH_HASH = '@@AUTH_HASH@@';
session_start();
if (isset($_POST['__auth_pass'])) {
    if (hash_equals($__AUTH_HASH, hash('sha256', $_POST['__auth_pass']))) {
        session_regenerate_id(true);
        $_SESSION['__authed'] = true;
        header('Location: ' . strtok($_SERVER['REQUEST_URI'], '?'));
        exit;
    }
}
if (isset($_GET['logout'])) {
    session_destroy();
    ob_end_clean();
    header('Content-Type: text/html; charset=UTF-8');
    $___logout_to = strtok($_SERVER['REQUEST_URI'], '?') ?: '.';
    echo '<script>try{sessionStorage.removeItem("__enc_key")}catch(e){}location.replace('
        . json_encode($___logout_to) . ');</script>';
    exit;
}
if (empty($_SESSION['__authed'])) {
    ob_end_clean();
    header('Content-Type: text/html; charset=UTF-8');
    /*@@LOGIN_ECHO@@*/
    exit;
}
