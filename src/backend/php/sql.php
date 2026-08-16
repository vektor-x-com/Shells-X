<?php
// ==================== SQL PROBE ====================
if (isset($_POST['action']) && $_POST['action'] === 'sql_probe') {
    if (ob_get_level() > 0) ob_end_clean();
    header('Content-Type: application/json');
    echo json_encode([
        'mysqli'    => extension_loaded('mysqli'),
        'pdo_mysql' => extension_loaded('pdo_mysql'),
        'pdo_pgsql' => extension_loaded('pdo_pgsql'),
    ]);
    exit;
}

// ==================== SQL QUERY ====================
if (isset($_POST['action']) && $_POST['action'] === 'sql_query') {
    if (ob_get_level() > 0) ob_end_clean();
    header('Content-Type: application/json');

    $host     = trim($_POST['host']      ?? '127.0.0.1');
    $port     = (int) ($_POST['port']    ?? 3306);
    $db       = trim($_POST['db']        ?? '');
    $user     = trim($_POST['user']      ?? '');
    $password = $_POST['password']       ?? '';
    $driver   = trim($_POST['driver']    ?? 'mysql');
    $query    = trim($_POST['query']     ?? '');
    $timeout  = (int) ($_POST['timeout'] ?? 30);

    set_time_limit($timeout > 0 ? $timeout : 30);

    if ($query === '') {
        echo json_encode(['error' => 'Empty query']);
        exit;
    }

    $maxRows = 500;
    $conn    = null;
    $method  = '';

    // DSN components are concatenated into PDO connection strings — strip
    // DSN metacharacters so a host/db like "x;unix_socket=/" can't smuggle
    // extra parameters into the string. mysqli passes them as separate
    // arguments and needs no such scrubbing.
    $dsnSafe = function ($s) { return preg_replace('/[;=\s]/', '', $s); };
    $host = $dsnSafe($host);
    $db   = $dsnSafe($db);
    if ($port < 1 || $port > 65535) $port = $driver === 'pgsql' ? 5432 : 3306;
    if ($host === '') $host = '127.0.0.1';

    // ---- Connect ----
    if ($driver === 'pgsql') {
        if (!extension_loaded('pdo_pgsql')) {
            echo json_encode(['error' => 'pdo_pgsql extension not available']);
            exit;
        }
        try {
            $dsn  = 'pgsql:host=' . $host . ';port=' . $port . ';dbname=' . $db;
            $conn = new PDO($dsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
            $method = 'pdo_pgsql';
        } catch (Exception $e) {
            echo json_encode(['error' => 'Connection failed: ' . $e->getMessage()]);
            exit;
        }
    } else {
        // MySQL: prefer mysqli, fall back to pdo_mysql
        if (extension_loaded('mysqli')) {
            mysqli_report(MYSQLI_REPORT_OFF);
            $m = @new mysqli($host, $user, $password, $db, $port);
            if (!$m->connect_error) {
                $conn   = $m;
                $method = 'mysqli';
            }
        }
        if (!$conn && extension_loaded('pdo_mysql')) {
            try {
                $dsn  = 'mysql:host=' . $host . ';port=' . $port . ';dbname=' . $db . ';charset=utf8mb4';
                $conn = new PDO($dsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
                $method = 'pdo_mysql';
            } catch (Exception $e) {
                echo json_encode(['error' => 'Connection failed: ' . $e->getMessage()]);
                exit;
            }
        }
        if (!$conn) {
            echo json_encode(['error' => 'Connection failed: no mysqli/pdo_mysql extension or wrong credentials']);
            exit;
        }
    }

    // ---- Execute ----
    try {
        if ($method === 'mysqli') {
            $res = $conn->query($query);
            if ($res === false) {
                $err = $conn->error;
                $conn->close();
                echo json_encode(['error' => $err]);
                exit;
            }
            if ($res === true) {
                $affected = $conn->affected_rows;
                $conn->close();
                echo json_encode(['affected' => $affected]);
                exit;
            }
            // Result set (SELECT / SHOW / DESCRIBE etc.)
            $fields  = $res->fetch_fields();
            $columns = [];
            foreach ($fields as $f) $columns[] = $f->name;
            $rows      = [];
            $truncated = false;
            while ($row = $res->fetch_row()) {
                $safe = [];
                foreach ($row as $v) $safe[] = $v === null ? 'NULL' : (string) $v;
                $rows[] = $safe;
                if (count($rows) >= $maxRows) { $truncated = true; break; }
            }
            $res->free();
            $conn->close();
            $out = ['columns' => $columns, 'rows' => $rows, 'count' => count($rows)];
            if ($truncated) $out['truncated'] = true;
            echo json_encode($out);
        } else {
            // PDO (pdo_mysql or pdo_pgsql)
            $stmt = $conn->query($query);
            $colCount = $stmt->columnCount();
            if ($colCount > 0) {
                $columns = [];
                for ($i = 0; $i < $colCount; $i++) {
                    $meta      = $stmt->getColumnMeta($i);
                    $columns[] = isset($meta['name']) ? $meta['name'] : 'col' . $i;
                }
                $rows      = [];
                $truncated = false;
                while ($row = $stmt->fetch(PDO::FETCH_NUM)) {
                    $safe = [];
                    foreach ($row as $v) $safe[] = $v === null ? 'NULL' : (string) $v;
                    $rows[] = $safe;
                    if (count($rows) >= $maxRows) { $truncated = true; break; }
                }
                $out = ['columns' => $columns, 'rows' => $rows, 'count' => count($rows)];
                if ($truncated) $out['truncated'] = true;
                echo json_encode($out);
            } else {
                echo json_encode(['affected' => $stmt->rowCount()]);
            }
        }
    } catch (Exception $e) {
        echo json_encode(['error' => $e->getMessage()]);
    }
    exit;
}
