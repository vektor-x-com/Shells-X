<?php
// Shared PHP helper utilities for backend modules.
//
// These helpers centralize canonical path handling, session save path
// normalization, and file access restrictions for diagnostics, download,
// and other backend endpoints.

function shells_x_realpath(string $path): array {
    if ($path === '')
        return ['error' => 'path is empty'];
    $real = realpath($path);
    if ($real === false)
        return ['error' => "path does not exist or is not accessible: $path"];
    return ['path' => $real];
}

function shells_x_parse_session_save_path(string $savePath): array {
    if ($savePath === '')
        return ['path' => sys_get_temp_dir()];

    // session.save_path can be in the form "N;/path" when using user-level
    if (preg_match('/^\d+;(.*)$/', $savePath, $matches))
        $savePath = $matches[1];

    // session.save_path can also be a file:// URL if using a custom session handler (very rare).
    $parsed = parse_url($savePath);
    if ($parsed === false)
        return ['error' => "failed to parse session save path: $savePath"];

    if (isset($parsed['scheme'])) {
        $scheme = strtolower($parsed['scheme']);
        if ($scheme !== 'file')
            return ['error' => "unsupported session save path scheme: $scheme"];
        $savePath = $parsed['path'] ?? '';
    }

    $savePath = rtrim($savePath, '/');
    if ($savePath === '')
        return ['error' => 'session save path resolved to empty string'];

    return ['path' => $savePath];
}

function shells_x_path_within(string $path, string $base): bool {
    $path = rtrim($path, '/');
    $base = rtrim($base, '/');
    if ($base === '')
        return false;
    return $path === $base || strpos($path, $base . '/') === 0;
}

function shells_x_is_path_allowed(string $path, array $allowedRoots): bool {
    foreach ($allowedRoots as $root) {
        if (!is_string($root) || $root === '')
            continue;
        if (shells_x_path_within($path, $root))
            return true;
    }
    return false;
}

function shells_x_validate_readable_file(string $path): array {
    $result = shells_x_realpath($path);
    if (isset($result['error']))
        return $result;
    $real = $result['path'];
    if (!is_file($real))
        return ['error' => "not a regular file: $real"];
    if (!is_readable($real))
        return ['error' => "file is not readable: $real"];
    return ['path' => $real];
}

function shells_x_read_file_truncated(string $path, int $maxBytes = 20000): array {
    $raw = @file_get_contents($path, false, null, 0, $maxBytes + 1);
    if ($raw === false)
        return ['error' => "read failed: $path"];
    $truncated = strlen($raw) > $maxBytes;
    if ($truncated)
        $raw = substr($raw, 0, $maxBytes);
    return ['content' => $raw, 'truncated' => $truncated];
}
