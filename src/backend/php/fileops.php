if (isset($_POST['action']) && $_POST['action'] === 'delete') {
ob_end_clean();
header('Content-Type: application/json');
$path = $_POST['path'] ?? '';
if (!$path) {
echo json_encode(['error' => 'No path provided']);
exit;
}
if (!file_exists($path) && !is_link($path)) {
echo json_encode(['error' => 'Path does not exist: ' . $path]);
exit;
}
try {
if (is_link($path) || is_file($path)) {
if (!@unlink($path)) {
$err = error_get_last();
throw new Exception('unlink() failed on ' . $path . ': ' . ($err['message'] ?? 'unknown error'));
}
} elseif (is_dir($path)) {
$items = @scandir($path);
if ($items && count($items) > 2) {
throw new Exception('Directory not empty: ' . $path . ' (' . (count($items) - 2) . ' entries)');
}
if (!@rmdir($path)) {
$err = error_get_last();
throw new Exception('rmdir() failed on ' . $path . ': ' . ($err['message'] ?? 'unknown error'));
}
}
echo json_encode(['ok' => true]);
} catch (Exception $e) {
echo json_encode(['error' => $e->getMessage()]);
}
exit;
}

if (isset($_POST['action']) && $_POST['action'] === 'upload') {
ob_end_clean();
header('Content-Type: application/json');
$dir = $_POST['dir'] ?? '';
if (!$dir || !is_dir($dir)) {
echo json_encode(['error' => 'Invalid directory: ' . $dir]);
exit;
}
if (!is_writable($dir)) {
echo json_encode(['error' => 'Directory not writable: ' . $dir]);
exit;
}
if (empty($_FILES['file'])) {
echo json_encode(['error' => 'No file received']);
exit;
}
$uploadErrors = [
UPLOAD_ERR_INI_SIZE => 'File exceeds upload_max_filesize (' . ini_get('upload_max_filesize') . ')',
UPLOAD_ERR_FORM_SIZE => 'File exceeds MAX_FILE_SIZE form directive',
UPLOAD_ERR_PARTIAL => 'File was only partially uploaded',
UPLOAD_ERR_NO_FILE => 'No file was uploaded',
UPLOAD_ERR_NO_TMP_DIR => 'Missing temp directory on server',
UPLOAD_ERR_CANT_WRITE => 'Failed to write to disk',
UPLOAD_ERR_EXTENSION => 'Upload blocked by PHP extension',
];
$errCode = $_FILES['file']['error'];
if ($errCode !== UPLOAD_ERR_OK) {
echo json_encode(['error' => $uploadErrors[$errCode] ?? 'Unknown upload error (code ' . $errCode . ')']);
exit;
}
try {
$name = basename($_FILES['file']['name']);
$dest = rtrim($dir, '/') . '/' . $name;
$overwritten = file_exists($dest);
if (!@move_uploaded_file($_FILES['file']['tmp_name'], $dest)) {
$err = error_get_last();
throw new Exception('move_uploaded_file() failed: ' . ($err['message'] ?? 'unknown error'));
}
echo json_encode(['ok' => true, 'path' => $dest, 'size' => $_FILES['file']['size'], 'overwritten' => $overwritten]);
} catch (Exception $e) {
echo json_encode(['error' => $e->getMessage()]);
}
exit;
}
