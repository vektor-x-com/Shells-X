<?php
// Shared PHP helper utilities for backend modules.
//
// These helpers centralize canonical path handling, session save path
// normalization, and file access restrictions for diagnostics, download,
// and other backend endpoints.

function shells_x_realpath(string $path): ?string {
    if ($path === '')
        return null;
    $real = realpath($path);
    return ($real === false) ? null : $real;
}

function shells_x_parse_session_save_path(string $savePath): ?string {
    if ($savePath === '')
        return sys_get_temp_dir();

    if (preg_match('/^\d+;(.*)$/', $savePath, $matches))
        $savePath = $matches[1];

    $parsed = parse_url($savePath);
    if ($parsed === false)
        return null;

    if (isset($parsed['scheme'])) {
        $scheme = strtolower($parsed['scheme']);
        if ($scheme !== 'file')
            return null;
        $savePath = $parsed['path'] ?? '';
    }

    $savePath = rtrim($savePath, '/');
    return $savePath === '' ? null : $savePath;
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

function shells_x_validate_readable_file(string $path): ?string {
    $real = shells_x_realpath($path);
    if ($real === null)
        return null;
    if (!is_file($real) || !is_readable($real))
        return null;
    return $real;
}

function shells_x_read_file_truncated(string $path, int $maxBytes = 20000): array {
    $raw = @file_get_contents($path, false, null, 0, $maxBytes + 1);
    if ($raw === false)
        return ['error' => 'read failed'];
    $truncated = strlen($raw) > $maxBytes;
    if ($truncated)
        $raw = substr($raw, 0, $maxBytes);
    return ['content' => $raw, 'truncated' => $truncated];
}
